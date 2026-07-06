/**
 * Simulated M1K for hardware-out-of-the-loop testing.
 *
 * Implements the StreamingDevice contract with a wall-clock-paced sample
 * generator instead of USB pumps, so the full pixelpulse stack (dataserver,
 * listeners, triggering, decimation, UI) runs unmodified with no device.
 *
 * Each channel drives a software load:
 *   - Channel A: an LED (Shockley diode, ~2 V forward drop) — sourcing a
 *     voltage sweep across it traces the classic exponential I-V knee.
 *   - Channel B: 100 Ω to the 2.5 V rail — a linear load for sanity checks
 *     (I[mA] = (V - 2.5) / 0.1).
 *
 * Enabled by the `#sim` URL hash (see dataserver.ts backend selection).
 */

import { Channel, Stream, StreamingDevice } from './streaming-device';
import { makeConstantSource } from './output-source';
import type { UsbTransport } from './usb';

const V_MIN = 0.0;
const V_MAX = 5.0;
const I_MIN = -200.0; // mA
const I_MAX = 200.0; // mA
const V_RESOLUTION = 5.0 / 65536.0;
const I_RESOLUTION = 0.4 / 65536.0;
const DEFAULT_SAMPLE_TIME = 1.0 / 100000.0; // 100 ksps
const MIN_SAMPLE_TIME = 1.0 / 100000.0;

// Output-source modes (match M1KMode: 0=HI_Z, 1=SVMI, 2=SIMV)
const HI_Z = 0;
const SVMI = 1;
const SIMV = 2;

// LED model: I = IS * (exp(V / (N * VT)) - 1). IS/N picked for a red-LED-ish
// ~2.2 V drop at 20 mA, with a deliberately high ideality (n=4, ~240 mV per
// decade of current) so the knee reads as a shallow curve at plotting scale
// — like a real LED at its terminals — rather than a vertical wall.
const LED_IS = 1e-11; // A
const LED_NVT = 4 * 0.02585; // N * thermal voltage, V

// Channel B load: R ohms from the pin to the 2.5 V rail.
const B_RAIL = 2.5; // V
const B_R_KOHM = 0.1; // 100 ohms, in kOhm so V = RAIL + R * I[mA]

// Optional battery model replacing channel A's LED (for the battery-test
// applet): linear OCV vs state-of-charge with a series resistance. With
// R = 1 Ω, a 4.2 V CV hold naturally tapers: I[mA] = (4.2 - Voc) * 1000,
// hitting a 10 mA cutoff at Voc = 4.19 V — same shape as a real CC/CV tail.
const BAT_V_EMPTY = 3.0;
const BAT_V_SPAN = 1.2; // Voc = 3.0 + 1.2 * SOC → 4.2 V at SOC = 1
const BAT_R_OHM = 1.0;
const BAT_SOC_INITIAL = 0.55; // ~3.66 V, storage-ish

const V_NOISE = 0.002; // V p-p/2
const I_NOISE = 0.05; // mA p-p/2

const GEN_INTERVAL_MS = 25;
const MAX_CHUNK_SECONDS = 0.25; // cap per-tick backlog (e.g. after a debugger pause)
const PACKET_SAMPLES = 256; // data-event granularity, like a USB packet

function clamp(x: number, lo: number, hi: number): number {
  return x > hi ? hi : x < lo ? lo : x;
}

function noise(amplitude: number): number {
  return (Math.random() - 0.5) * 2 * amplitude;
}

// Channel A load (LED): current in mA for a pin voltage.
function ledCurrentMA(v: number): number {
  if (v <= 0) return 0;
  return clamp(LED_IS * Math.expm1(v / LED_NVT) * 1000, I_MIN, I_MAX);
}

// Channel A load inverse: pin voltage when forcing a current (mA).
function ledVoltage(iMA: number): number {
  if (iMA <= 0) return 0;
  return clamp(LED_NVT * Math.log1p((iMA / 1000) / LED_IS), V_MIN, V_MAX);
}

export class SimM1K extends StreamingDevice {
  readonly channelA = new Channel('a', 'A');
  readonly channelB = new Channel('b', 'B');

  readonly channelAV = new Stream('v', 'Voltage A', 'V', V_MIN, V_MAX, 1, V_RESOLUTION, 1);
  readonly channelAI = new Stream('i', 'Current A', 'mA', I_MIN, I_MAX, 2, I_RESOLUTION * 1000.0, 1);
  readonly channelBV = new Stream('v', 'Voltage B', 'V', V_MIN, V_MAX, 1, V_RESOLUTION, 1);
  readonly channelBI = new Stream('i', 'Current B', 'mA', I_MIN, I_MAX, 2, I_RESOLUTION * 1000.0, 1);

  // The generic dataserver paths never touch USB; M1K-specific extras
  // (VBUS/temperature/frontend hardware) fail cleanly through the command
  // layer's error handling.
  readonly usb = null as unknown as UsbTransport;

  // Battery emulation on channel A (instead of the LED) when capacity is set
  private batteryMAh = 0;
  private batterySOC = BAT_SOC_INITIAL;

  constructor(opts: { batteryMAh?: number } = {}) {
    super(DEFAULT_SAMPLE_TIME);
    this.minSampleTime = MIN_SAMPLE_TIME;
    this.batteryMAh = opts.batteryMAh ?? 0;
    // Mirror M1KDevice.init(): arrive already configured for a 12 s
    // continuous buffer, so channels/streams exist when the dataserver
    // wraps this device and delivers the initial config to the UI.
    // (No awaits block in the sim, so this completes synchronously.)
    void this.configure(0, DEFAULT_SAMPLE_TIME, Math.ceil(12.0 / DEFAULT_SAMPLE_TIME), true, false);
  }

  get model(): string {
    return 'com.analogdevices.m1k';
  }

  get hwVersion(): string {
    return 'SIM';
  }

  get fwVersion(): string {
    return '9.99';
  }

  get serial(): string {
    return 'SIM000000000001';
  }

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGenTime = 0;
  private sampleDebt = 0; // fractional samples owed to wall-clock pacing

  async configure(mode: number, sampleTime: number, samples: number, continuous: boolean, raw: boolean): Promise<void> {
    await this.pauseCapture();

    this.channels = [];
    this.channelA.streams = [];
    this.channelB.streams = [];

    this.sampleTime = Math.max(sampleTime, this.minSampleTime);
    this.captureSamples = samples;
    this.captureContinuous = continuous;
    this.devMode = mode;
    this.rawMode = raw;
    this.captureLength = this.captureSamples * this.sampleTime;

    this.capture_i = this.capture_o = 0;

    this.channels.push(this.channelA);
    this.channelA.source = makeConstantSource(0, 0);
    this.channelA.streams.push(this.channelAV, this.channelAI);

    this.channels.push(this.channelB);
    this.channelB.source = makeConstantSource(0, 0);
    this.channelB.streams.push(this.channelBV, this.channelBI);

    this.channelAV.allocate(this.captureSamples);
    this.channelAI.allocate(this.captureSamples);
    this.channelBV.allocate(this.captureSamples);
    this.channelBI.allocate(this.captureSamples);

    this.notifyConfig();
  }

  async close(): Promise<void> {
    await this.pauseCapture();
  }

  protected async onResetCapture(): Promise<void> {
    this.sampleDebt = 0;
  }

  protected async onStartCapture(): Promise<void> {
    this.lastGenTime = performance.now();
    this.sampleDebt = 0;
    this.timer = setInterval(() => this.generate(), GEN_INTERVAL_MS);
  }

  protected async onPauseCapture(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Battery on channel A: OCV from SOC, series-R terminal behavior, and
  // coulomb integration of whatever current the mode forces.
  private simBattery(mode: number, setpoint: number): [number, number] {
    const voc = BAT_V_EMPTY + BAT_V_SPAN * this.batterySOC;
    let v: number;
    let iMA: number;

    if (mode === SVMI) {
      v = clamp(setpoint, V_MIN, V_MAX);
      iMA = clamp(((v - voc) / BAT_R_OHM) * 1000, I_MIN, I_MAX);
    } else if (mode === SIMV) {
      iMA = clamp(setpoint, I_MIN, I_MAX);
      v = clamp(voc + (iMA / 1000) * BAT_R_OHM, V_MIN, V_MAX);
    } else {
      iMA = 0;
      v = voc;
    }

    // Coulomb count: positive current charges. Slight overshoot headroom so
    // the CV tail behaves; discharge floor at empty.
    this.batterySOC = clamp(
      this.batterySOC + (iMA * (this.sampleTime / 3600)) / this.batteryMAh,
      0, 1.05,
    );
    return [v, iMA];
  }

  // Simulate one channel at sample index `i`: read the commanded output,
  // apply the load physics, return [V, I(mA)].
  private simChannel(ch: Channel, isLED: boolean, i: number): [number, number] {
    const source = ch.source;
    const mode = source?.mode ?? HI_Z;
    const setpoint = source?.getValue(i, this.sampleTime) ?? 0;

    let v: number;
    let iMA: number;

    if (isLED && this.batteryMAh > 0) {
      [v, iMA] = this.simBattery(mode, setpoint);
    } else if (mode === SVMI) {
      v = clamp(setpoint, V_MIN, V_MAX);
      iMA = isLED ? ledCurrentMA(v) : (v - B_RAIL) / B_R_KOHM;
    } else if (mode === SIMV) {
      iMA = clamp(setpoint, I_MIN, I_MAX);
      v = isLED ? ledVoltage(iMA) : B_RAIL + B_R_KOHM * iMA;
    } else {
      // Hi-Z: no drive; the pin sits at the load's open-circuit voltage.
      iMA = 0;
      v = isLED ? 0 : B_RAIL;
    }

    return [
      clamp(v + noise(V_NOISE), V_MIN, V_MAX),
      clamp(iMA + noise(I_NOISE), I_MIN, I_MAX),
    ];
  }

  private generate(): void {
    if (!this.captureState || !this.captureSamples) return;

    const now = performance.now();
    let dt = (now - this.lastGenTime) / 1000;
    this.lastGenTime = now;
    if (dt > MAX_CHUNK_SECONDS) dt = MAX_CHUNK_SECONDS;

    this.sampleDebt += dt / this.sampleTime;
    let n = Math.floor(this.sampleDebt);
    this.sampleDebt -= n;

    while (n > 0) {
      const chunk = Math.min(n, PACKET_SAMPLES);
      for (let k = 0; k < chunk; k++) {
        const i = this.capture_i;
        const [av, ai] = this.simChannel(this.channelA, true, i);
        const [bv, bi] = this.simChannel(this.channelB, false, i);
        this.put(this.channelAV, av);
        this.put(this.channelAI, ai);
        this.put(this.channelBV, bv);
        this.put(this.channelBI, bi);
        this.capture_o++;
        this.sampleDone();

        // Finite capture filled: stop generating; packetDone() below flips
        // the state machine to done.
        if (!this.captureContinuous && this.capture_i >= this.captureSamples) {
          n = chunk;
          break;
        }
      }
      n -= chunk;
      this.packetDone();
      if (!this.captureState) break; // doneCapture may have paused us
    }
  }
}
