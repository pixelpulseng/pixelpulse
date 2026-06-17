/**
 * WebUSB backend: drives the hardware in-process through src/smu/,
 * no daemon required. One tab owns the device (exclusive interface claim);
 * use the WebSocket backend (dataserver-ws.ts) for multi-client or remote
 * operation.
 */

import {
  TypedEvent,
  SMUSession,
  isSupported,
  StreamingDevice as SmuStreamingDevice,
  CEEDevice as SmuCEEDevice,
  M1KDevice as SmuM1KDevice,
  BootloaderDevice as SmuBootloaderDevice,
  StreamListener,
  makeSource,
} from './smu/index.js';
import type {
  SMUDevice,
  Channel as SmuChannel,
  SourceDescription,
  TriggerConfig as SmuTriggerConfig,
  M1KFrontendSwitch,
} from './smu/index.js';
import {
  Dataserver, Device, CEEDevice, BootloaderDevice,
  removeNull,
} from './dataserver-common.js';
import type { ChannelInfo, StreamInfo, OutputSource, Reply } from './dataserver-common.js';

function toHex(val: number): string {
  return (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** Byte-swap a u32 (struct fields were displayed via ntohl in Connect) */
function bswap32(v: number): number {
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
}

// --- WebUSB Dataserver ---

export class USBDataserver extends Dataserver {
  readonly session = new SMUSession();

  private records = new Map<USBDevice, Device>();
  private refreshing: Promise<void> | null = null;

  constructor() {
    super();
    // Feature gates in the GUI compare against the Connect version;
    // everything Connect 1.2+ offered is supported here
    this.version = '1.3';
    this.gitVersion = 'webusb';
  }

  connect(): void {
    if (!isSupported()) {
      console.error('WebUSB is not supported in this browser');
      this.disconnected.notify();
      return;
    }

    this.session.devicesChanged.subscribe(() => {
      void this.refreshDevices();
    });

    void this.session
      .start()
      .then(() => this.connected.notify())
      .catch((e) => {
        console.error('WebUSB session failed:', e);
        this.disconnected.notify();
      });
  }

  /**
   * Show the browser's USB device chooser to pair a new device.
   * Must be called from a user gesture (click handler).
   */
  async requestDevice(): Promise<void> {
    await this.session.requestDevice();
  }

  private refreshDevices(): Promise<void> {
    // Serialize refreshes so a hotplug during driver init can't interleave
    const prev = this.refreshing ?? Promise.resolve();
    const next = prev.then(() => this.doRefreshDevices());
    this.refreshing = next.finally(() => {
      if (this.refreshing === next) this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefreshDevices(): Promise<void> {
    const available = this.session.available;

    // Drop records for detached devices
    for (const usb of [...this.records.keys()]) {
      if (!available.includes(usb)) {
        this.records.delete(usb);
      }
    }

    // Open drivers for newly attached devices (Connect also opened every
    // device at attach; this is what populates serial/hw/fw in the list)
    for (const usb of available) {
      if (this.records.has(usb)) continue;
      try {
        const driver = await this.session.open(usb);
        this.records.set(usb, new USBDevice_(driver));
      } catch (e) {
        console.error('Could not open device (in use by another tab?):', e);
      }
    }

    this.devices = [...this.records.values()];

    // If the active device went away, mirror the WS 'deviceDisconnected' flow
    if (
      this.device &&
      !this.devices.some((d) => (d as USBDevice_).driver === (this.device as USBCEEDevice | USBBootloaderDevice).driver)
    ) {
      const d = this.device;
      this.device = null;
      d.dispose();
      d.removed.notify();
    }

    this.updatePairButton();
    this.devicesChanged.notify(this.devices);
  }

  // Commands run strictly in submission order, as they did over the Connect
  // WebSocket: callers issue sequences like configure-then-startCapture
  // without awaiting, which must not interleave. dispatch() never rejects
  // (errors are reported through the reply callback), so the chain is safe.
  private commandQueue: Promise<void> = Promise.resolve();

  send(cmd: string, m: Record<string, unknown> = {}): void {
    this.commandQueue = this.commandQueue.then(() => this.dispatch(cmd, m));
  }

  private async dispatch(cmd: string, m: Record<string, unknown>): Promise<void> {
    const id = m.id as number | string | undefined;
    try {
      const dev = this.device as USBCEEDevice | USBBootloaderDevice | null;
      const reply = (await dev?.handleCommand(cmd, m)) ?? {};
      if (id != null && id !== '') {
        reply._action = 'return';
        reply.id = id;
        this.runCallback(id, reply);
      }
    } catch (e) {
      console.error(`Command ${cmd} failed:`, e);
      if (id != null && id !== '') {
        this.runCallback(id, { _action: 'return', id, error: String(e), status: -1 });
      }
    }
  }

  // --- Pairing UI ---
  // WebUSB needs a user gesture to grant access to a new device. When no
  // granted devices are present, float a pairing button over whatever page
  // is showing so every app gets the flow without page-specific UI.

  private pairButton: HTMLButtonElement | null = null;

  private updatePairButton(): void {
    if (typeof document === 'undefined') return;

    if (this.devices.length > 0) {
      this.pairButton?.remove();
      this.pairButton = null;
      return;
    }

    if (this.pairButton) return;

    const btn = document.createElement('button');
    btn.textContent = '\u{1F50C} Connect USB device…';
    btn.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:10000;font-size:15px;' +
      'padding:8px 14px;cursor:pointer;border-radius:6px;border:1px solid #888;';
    btn.addEventListener('click', () => {
      void this.requestDevice();
    });
    this.pairButton = btn;

    const attach = (): void => {
      document.body.appendChild(btn);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }
}

// --- Device (list entry; the driver is already open) ---
// Named with a trailing underscore to avoid colliding with the WebUSB
// global USBDevice type.

export class USBDevice_ extends Device {
  constructor(public readonly driver: SMUDevice) {
    super();
    this.model = driver.model;
    this.serial = removeNull(driver.serial);
    this.id = this.model + '~' + this.serial;
    this.hwVersion = removeNull(driver.hwVersion);
    this.fwVersion = removeNull(driver.fwVersion);
  }

  makeActiveObj(parent: Dataserver): CEEDevice | BootloaderDevice {
    if (this.driver instanceof SmuBootloaderDevice) {
      return new USBBootloaderDevice(parent, this.driver);
    }
    return new USBCEEDevice(parent, this.driver as SmuStreamingDevice);
  }
}

// --- Active CEE/M1K device on the WebUSB backend ---

export class USBCEEDevice extends CEEDevice {
  private smuListeners = new Map<number, StreamListener>();
  private disposers: Array<() => void> = [];
  private disposed = false;

  constructor(parent: Dataserver, public readonly driver: SmuStreamingDevice) {
    super(parent);

    const on = <T extends unknown[]>(ev: TypedEvent<T>, fn: (...args: T) => void): void => {
      ev.subscribe(fn);
      this.disposers.push(() => ev.unListen(fn));
    };

    on<[SmuStreamingDevice]>(this.driver.configChanged, () => this.onConfig());
    on(this.driver.captureStateChanged, (state, done) => {
      this.captureState = state;
      this.captureDone = done;
      this.captureStateChanged.notify(this.captureState);
    });
    on(this.driver.captureReset, () => {
      for (const sl of this.smuListeners.values()) sl.reset();
      this.samplesReset.notify();
      for (const id in this.listenersById) {
        this.listenersById[id].onReset();
      }
    });
    on<[SmuStreamingDevice]>(this.driver.data, () => this.pumpListeners());
    on(this.driver.outputChanged, (ch, src) => {
      this.channels[ch.id]?.onOutputChanged(src.describe() as OutputSource);
    });
    on(this.driver.gainChanged, (ch, st, gain) => {
      this.channels[ch.id]?.streams[st.id]?.onGain(gain);
    });
    on(this.driver.packetDrop, () => console.log('dropped packet'));
    on(this.driver.disconnected, () => {
      // Hotplug removal of the active device is handled centrally by
      // USBDataserver.refreshDevices; just stop our listeners here.
      this.smuListeners.clear();
    });

    // Deliver the initial configuration after the caller has had a chance
    // to subscribe `changed` (mirrors the async WS deviceConfig message)
    queueMicrotask(() => {
      if (!this.disposed) this.onConfig();
    });
  }

  override dispose(): void {
    this.disposed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.smuListeners.clear();
  }

  protected override onListenersInvalidated(): void {
    this.smuListeners.clear();
  }

  private onConfig(): void {
    const d = this.driver;

    const channels: Record<string, ChannelInfo> = {};
    for (const ch of d.channels) {
      const streams: Record<string, StreamInfo> = {};
      for (const s of ch.streams) {
        streams[s.id] = {
          id: s.id,
          displayName: s.displayName,
          units: s.units,
          min: s.min,
          max: s.max,
          outputMode: s.outputMode,
          gain: s.getGain(),
          uncertainty: s.uncertainty,
        };
      }
      channels[ch.id] = {
        id: ch.id,
        displayName: ch.displayName,
        output: (ch.source?.describe() ?? { mode: 0, source: 'constant', value: 0 }) as OutputSource,
        streams,
      };
    }

    this.onInfo({
      id: this.parent.devices.find((rec) => (rec as USBDevice_).driver === d)?.id ?? d.serial,
      model: d.model,
      serial: d.serial,
      hwVersion: d.hwVersion,
      fwVersion: d.fwVersion,
      length: d.captureLength,
      continuous: d.captureContinuous,
      sampleTime: d.sampleTime,
      captureState: d.captureState,
      captureDone: d.captureDone,
      mode: d.devMode,
      samples: d.captureSamples,
      raw: d.rawMode,
      minSampleTime: d.minSampleTime,
      channels,
    });
  }

  // --- Listener pump ---

  private pumpListeners(): void {
    for (const [id, sl] of this.smuListeners) {
      this.pumpListener(id, sl);
    }
  }

  private pumpListener(id: number, sl: StreamListener): void {
    const { updates, finished } = sl.poll();
    for (const u of updates) {
      this.listenersById[id]?.onMessage({
        _action: 'update',
        id,
        idx: u.idx,
        sampleIndex: u.sampleIndex,
        subsample: u.subsample as number,
        data: u.data,
        done: u.done,
        triggerForced: u.triggerForced,
      });
    }
    if (finished) {
      this.smuListeners.delete(id);
    }
  }

  // --- Command dispatcher (the old WS protocol surface) ---

  async handleCommand(cmd: string, m: Record<string, unknown>): Promise<Reply> {
    const driver = this.driver;

    switch (cmd) {
      case 'configure': {
        await driver.configure(
          (m.mode as number) ?? 0,
          m.sampleTime as number,
          Math.round(m.samples as number),
          !!m.continuous,
          !!m.raw,
        );
        return {};
      }

      case 'startCapture':
        await driver.startCapture();
        return {};

      case 'pauseCapture':
        await driver.pauseCapture();
        return {};

      case 'set': {
        const channel = this.requireChannel(m.channel as string);
        const source = makeSource(m as SourceDescription);
        await driver.setOutput(channel, source);
        return {};
      }

      case 'setGain': {
        const channel = this.requireChannel(m.channel as string);
        const stream = driver.findStream(m.channel as string, m.stream as string);
        await driver.setGain(channel, stream, m.gain as number);
        return {};
      }

      case 'listen': {
        const id = m.id as number;
        const streamSpecs = m.streams as Array<{ channel: string; stream: string }>;
        const t = m.trigger as
          | { type?: string; channel: string; stream: string; level: number; holdoff?: number; offset?: number; force?: number }
          | undefined;

        let trigger: SmuTriggerConfig | null = null;
        if (t) {
          if ((t.type ?? 'in') === 'in') {
            trigger = {
              type: 'in',
              stream: driver.findStream(t.channel, t.stream),
              level: t.level,
              holdoff: t.holdoff,
              offset: t.offset,
              force: t.force,
            };
          } else {
            trigger = {
              type: 'out',
              channel: this.requireChannel(t.channel),
              holdoff: t.holdoff,
              offset: t.offset,
              force: t.force,
            };
          }
        }

        const sl = new StreamListener(driver, {
          streams: streamSpecs.map((s) => driver.findStream(s.channel, s.stream)),
          decimateFactor: m.decimateFactor as number,
          start: m.start as number,
          count: m.count as number,
          trigger,
        });
        this.smuListeners.set(id, sl);
        // Connect delivered any already-buffered data immediately on listen
        this.pumpListener(id, sl);
        return {};
      }

      case 'cancelListen': {
        this.smuListeners.delete(m.id as number);
        return {};
      }

      case 'controlTransfer':
        return controlTransferCommand(driver.usb, m);

      case 'enterBootloader': {
        if (driver instanceof SmuCEEDevice) {
          await driver.enterBootloader();
        } else {
          throw new Error('enterBootloader is only supported on the CEE');
        }
        return {};
      }

      case 'readCalibration': {
        // Reply from the cached calibration, as Connect did
        if (driver instanceof SmuM1KDevice) {
          const c = driver.cal;
          return { offset: [...c.offset], gain_p: [...c.gain_p], gain_n: [...c.gain_n], valid: c.valid };
        }
        if (driver instanceof SmuCEEDevice) {
          const c = driver.cal;
          return {
            offset_a_v: c.offset_a_v, offset_a_i: c.offset_a_i,
            offset_b_v: c.offset_b_v, offset_b_i: c.offset_b_i,
            dac200_a: c.dac200_a, dac200_b: c.dac200_b,
            dac400_a: c.dac400_a, dac400_b: c.dac400_b,
            current_gain_a: c.current_gain_a, current_gain_b: c.current_gain_b,
            flags: c.flags,
          };
        }
        throw new Error('readCalibration: unsupported device');
      }

      case 'writeCalibration': {
        if (driver instanceof SmuM1KDevice) {
          await driver.writeCalibration({
            valid: true,
            offset: m.offset as number[],
            gain_p: m.gain_p as number[],
            gain_n: m.gain_n as number[],
          });
          return { status: 100 };
        }
        if (driver instanceof SmuCEEDevice) {
          const num = (k: string, dflt?: number): number => {
            const v = m[k];
            if (v == null) {
              if (dflt === undefined) throw new Error(`writeCalibration: missing ${k}`);
              return dflt;
            }
            return v as number;
          };
          await driver.writeCalibration({
            magic: 0, // set by the driver
            offset_a_v: num('offset_a_v'), offset_a_i: num('offset_a_i'),
            offset_b_v: num('offset_b_v'), offset_b_i: num('offset_b_i'),
            dac200_a: num('dac200_a'), dac200_b: num('dac200_b'),
            dac400_a: num('dac400_a'), dac400_b: num('dac400_b'),
            current_gain_a: num('current_gain_a', 0xffffffff),
            current_gain_b: num('current_gain_b', 0xffffffff),
            flags: num('flags', 0xff),
          });
          return { status: 25 };
        }
        throw new Error('writeCalibration: unsupported device');
      }

      case 'tempCalibration': {
        if (driver instanceof SmuCEEDevice) {
          driver.tempCalibration({
            offset_a_v: (m.offset_a_v as number) ?? 0,
            offset_a_i: (m.offset_a_i as number) ?? 0,
            offset_b_v: (m.offset_b_v as number) ?? 0,
            offset_b_i: (m.offset_b_i as number) ?? 0,
          });
        }
        return {};
      }

      case 'getPower': {
        const p = await this.m1k().readPower();
        return { power: { status_raw: p.statusRaw, alert_bit: p.alertBit, overcurrent: p.overcurrent } };
      }

      case 'getTemperature': {
        const t = await this.m1k().readTemperature();
        return { temperature: { a: t.a, b: t.b } };
      }

      case 'getFrontend':
        return { frontend: this.frontendReply() };

      case 'setFrontend': {
        const m1k = this.m1k();
        const ch: 0 | 1 = m.channel === 'b' || m.channel === 'B' ? 1 : 0;

        const switches: M1KFrontendSwitch[] = ['r50_2v5', 'r50_gnd', 'feedback', 'output_en', 'split'];
        for (const name of switches) {
          if (m[name] != null) {
            await m1k.setFrontendSwitch(ch, name, !!m[name]);
          }
        }

        const potR1 = (m.pot_r1 as number) ?? -1;
        const potR2 = (m.pot_r2 as number) ?? -1;
        if (potR1 >= 0 || potR2 >= 0) {
          const fe = m1k.frontend[ch];
          await m1k.setDigipot(
            ch,
            potR1 >= 0 ? potR1 & 0x7f : fe.pot_r1,
            potR2 >= 0 ? potR2 & 0x7f : fe.pot_r2,
          );
        }

        return { frontend: this.frontendReply() };
      }

      case 'getLED':
        return { leds: this.ledReply() };

      case 'setLED': {
        const m1k = this.m1k();
        const val = (m.leds as number) ?? -1;
        if (val >= 0) {
          await m1k.setLEDs(val & 0x7);
        } else {
          let state = m1k.ledState;
          const bit = (key: string, mask: number): void => {
            if (m[key] != null) {
              if (m[key]) state |= mask;
              else state &= ~mask;
            }
          };
          bit('red', 0x4);
          bit('green', 0x2);
          bit('blue', 0x1);
          await m1k.setLEDs(state);
        }
        return { leds: this.ledReply() };
      }

      case 'setSerial': {
        const s = (m.serial as string) ?? '';
        await this.m1k().setSerial(s);
        return { status: s.length };
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  private requireChannel(id: string): SmuChannel {
    const c = this.driver.channelById(id);
    if (!c) throw new Error(`Channel not found: ${id}`);
    return c;
  }

  private m1k(): SmuM1KDevice {
    if (!(this.driver instanceof SmuM1KDevice)) {
      throw new Error('Command is only supported on the M1K');
    }
    return this.driver;
  }

  private frontendReply(): Reply {
    const m1k = this.m1k();
    const ch = (i: 0 | 1): Reply => {
      const fe = m1k.frontend[i];
      return {
        r50_2v5: fe.r50_2v5,
        r50_gnd: fe.r50_gnd,
        feedback: fe.feedback,
        output_en: fe.output_en,
        split: fe.split,
        pot: [fe.pot_r1, fe.pot_r2],
      };
    };
    return { a: ch(0), b: ch(1) };
  }

  private ledReply(): Reply {
    const m1k = this.m1k();
    const l = m1k.leds;
    return { leds: m1k.ledState, red: l.red, green: l.green, blue: l.blue };
  }
}

/** Shared `controlTransfer` command, used by both device wrappers */
async function controlTransferCommand(
  usb: { controlIn(t: number, r: number, v: number, i: number, l: number): Promise<DataView>; controlOut(t: number, r: number, v: number, i: number, d?: BufferSource): Promise<number> },
  m: Record<string, unknown>,
): Promise<Reply> {
  const bmRequestType = (m.bmRequestType as number) ?? 0xc0;
  const bRequest = m.bRequest as number;
  const wValue = (m.wValue as number) ?? 0;
  const wIndex = (m.wIndex as number) ?? 0;

  try {
    if (bmRequestType & 0x80) {
      let wLength = (m.wLength as number) ?? 64;
      if (wLength > 64) wLength = 64;
      if (wLength < 0) wLength = 0;
      const d = await usb.controlIn(bmRequestType, bRequest, wValue, wIndex, wLength);
      const data: number[] = [];
      for (let i = 0; i < d.byteLength; i++) data.push(d.getUint8(i));
      return { data, status: d.byteLength };
    } else {
      const src = m.data;
      let bytes: Uint8Array<ArrayBuffer>;
      if (Array.isArray(src)) {
        bytes = Uint8Array.from(src as number[]);
      } else if (typeof src === 'string') {
        bytes = Uint8Array.from(src, (c) => c.charCodeAt(0) & 0xff);
      } else {
        bytes = new Uint8Array(0);
      }
      const written = await usb.controlOut(bmRequestType, bRequest, wValue, wIndex, bytes);
      return { status: written };
    }
  } catch (e) {
    console.error('controlTransfer failed:', e);
    return { status: -1 };
  }
}

// --- Bootloader device on the WebUSB backend ---

export class USBBootloaderDevice extends BootloaderDevice {
  private disposed = false;

  constructor(parent: Dataserver, public readonly driver: SmuBootloaderDevice) {
    super(parent);
    // Deliver info after the caller has subscribed `changed` (mirrors the
    // async WS 'info' message)
    queueMicrotask(() => {
      if (!this.disposed) this.onInfo();
    });
  }

  override dispose(): void {
    this.disposed = true;
  }

  private onInfo(): void {
    const info = this.driver.info;
    this.serial = removeNull(this.driver.serial);
    this.magic = toHex(bswap32(info.magic));
    this.version = String(info.version);
    this.devid = toHex(bswap32(info.devid));
    this.page_size = info.pageSize;
    this.app_section_end = info.appSectionEnd;
    this.hw_product = removeNull(info.hwProduct);
    this.hw_version = removeNull(info.hwVersion);
    this.changed.notify(this);
  }

  async handleCommand(cmd: string, m: Record<string, unknown>): Promise<Reply> {
    switch (cmd) {
      case 'erase':
        await this.driver.erase();
        return {};
      case 'write': {
        const data = m.data as number[];
        await this.driver.write(Uint8Array.from(data));
        return { result: 0 };
      }
      case 'crc_app':
        return { crc: await this.driver.crcApp() };
      case 'crc_boot':
        return { crc: await this.driver.crcBoot() };
      case 'reset':
        await this.driver.reset();
        return {};
      case 'controlTransfer':
        return controlTransferCommand(this.driver.usb, m);
      default:
        throw new Error(`Unknown bootloader command: ${cmd}`);
    }
  }
}
