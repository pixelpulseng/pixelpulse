/**
 * Audio-jack instrument: the computer's speaker/headphone output as a signal
 * source and the microphone/line-in as a measurement channel, presented
 * through the StreamingDevice contract so the whole pixelpulse stack
 * (graphs, phosphor, triggering, exports, bodeplot) works unchanged.
 *
 * Honest limitations, by construction:
 *  - AC-coupled both directions; DC ("constant") sources reach the speaker
 *    but not your ears or the mic.
 *  - Amplitude is unitless full-scale (±1), uncalibrated, and shaped by the
 *    OS volume and mic gain.
 *  - Sample rate is the audio context's (typically 48 kHz); requested rates
 *    are ignored in favor of the hardware's.
 *
 * Channel map: 'a' = Out (the generated signal, also audible), 'b' = In
 * (microphone). Source mode 1 drives the Out waveform; mode 0 mutes it.
 */

import { Channel, Stream, StreamingDevice } from './streaming-device';
import { makeConstantSource } from './output-source';
import type { UsbTransport } from './usb';

const OUT_MODE = 1; // source mode that drives the output waveform
const PROC_SIZE = 4096; // ScriptProcessor buffer (85 ms at 48 kHz)

function clamp(x: number, lo: number, hi: number): number {
  return x > hi ? hi : x < lo ? lo : x;
}

export class AudioDevice extends StreamingDevice {
  readonly channelOut = new Channel('a', 'Out');
  readonly channelIn = new Channel('b', 'In');

  readonly outV = new Stream('v', 'Signal Out', 'FS', -1, 1, OUT_MODE, 1 / 32768, 1);
  readonly inV = new Stream('v', 'Mic In', 'FS', -1, 1, 0, 1 / 32768, 1);

  // No USB behind this device; hardware-specific commands fail through the
  // dispatcher's error handling.
  readonly usb = null as unknown as UsbTransport;

  private proc: ScriptProcessorNode | null = null;
  private micNode: MediaStreamAudioSourceNode;

  constructor(
    private readonly ctx: AudioContext,
    private readonly mic: MediaStream,
  ) {
    super(1 / ctx.sampleRate);
    this.minSampleTime = 1 / ctx.sampleRate;
    this.micNode = ctx.createMediaStreamSource(mic);
    // Arrive configured (12 s buffer), like the hardware drivers.
    void this.configure(0, this.minSampleTime, Math.ceil(12.0 * ctx.sampleRate), true, false);
  }

  get model(): string {
    return 'org.pixelpulse.audio';
  }

  get hwVersion(): string {
    return 'audio-jack';
  }

  get fwVersion(): string {
    return `${this.ctx.sampleRate / 1000}k`;
  }

  get serial(): string {
    return 'AUDIO00000000001';
  }

  async configure(mode: number, _sampleTime: number, samples: number, continuous: boolean, raw: boolean): Promise<void> {
    await this.pauseCapture();

    this.channels = [];
    this.channelOut.streams = [];
    this.channelIn.streams = [];

    // The audio clock is not adjustable — always run at the context rate.
    this.sampleTime = 1 / this.ctx.sampleRate;
    this.captureSamples = samples;
    this.captureContinuous = continuous;
    this.devMode = mode;
    this.rawMode = raw;
    this.captureLength = this.captureSamples * this.sampleTime;

    this.capture_i = this.capture_o = 0;

    this.channels.push(this.channelOut);
    this.channelOut.source = makeConstantSource(OUT_MODE, 0); // silence
    this.channelOut.streams.push(this.outV);

    this.channels.push(this.channelIn);
    // Mode -1 matches no stream's outputMode: the mic row renders as a pure
    // measurement (no source UI marks it as driving).
    this.channelIn.source = makeConstantSource(-1, 0);
    this.channelIn.streams.push(this.inV);

    this.outV.allocate(this.captureSamples);
    this.inV.allocate(this.captureSamples);

    this.notifyConfig();
  }

  async close(): Promise<void> {
    await this.pauseCapture();
    for (const track of this.mic.getTracks()) track.stop();
    await this.ctx.close();
  }

  protected async onResetCapture(): Promise<void> {}

  protected async onStartCapture(): Promise<void> {
    await this.ctx.resume();

    // ScriptProcessorNode is deprecated but gives aligned input+output
    // buffers in a single callback — exactly a streaming-instrument loop —
    // with no worklet/message-passing machinery. Its main-thread scheduling
    // is fine at 85 ms buffers.
    const proc = this.ctx.createScriptProcessor(PROC_SIZE, 1, 1);
    this.proc = proc;
    proc.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer.getChannelData(0);
      const outBuf = e.outputBuffer.getChannelData(0);
      const source = this.channelOut.source;
      const drive = source != null && source.mode === OUT_MODE;

      for (let k = 0; k < outBuf.length; k++) {
        const out = drive
          ? clamp(source.getValue(this.capture_o, this.sampleTime), -1, 1)
          : 0;
        outBuf[k] = out;
        this.put(this.outV, out);
        this.put(this.inV, inBuf[k]);
        this.capture_o++;
        this.sampleDone();
      }
      this.packetDone();
    };

    this.micNode.connect(proc);
    proc.connect(this.ctx.destination);
  }

  protected async onPauseCapture(): Promise<void> {
    if (this.proc) {
      this.micNode.disconnect(this.proc);
      this.proc.disconnect();
      this.proc.onaudioprocess = null;
      this.proc = null;
    }
  }
}
