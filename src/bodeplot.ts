/**
 * Bode plot / DSA (Dynamic Signal Analyzer) application
 * Ported from bodeplot.coffee
 * Original: (C) Nonolith Labs
 * Distributed under the terms of the GNU LGPLv3
 */

import { DataListener, CEEDevice, Stream } from './dataserver.js';
import { Axis, LogAxis, Series, GraphCanvas } from './livegraph.js';
import { arange } from './human-units.js';
import { initSession } from './session.js';
import { snapshotPNG } from './export.js';

declare class FFT {
  constructor(bufferSize: number, sampleRate: number);
  forward(buffer: Float32Array): void;
  real: Float32Array;
  imag: Float32Array;
  bufferSize: number;
}

const stepTimeRatio = 0.25;
const sampleScale = 8192;

// --- Vector helpers ---

function vDiff(inArray: Float32Array, outArray: Float32Array): void {
  for (let i = 0; i < inArray.length - 1; i++) {
    outArray[i] = inArray[i + 1] - inArray[i];
  }
}

function vAccumulate(inArray: Float32Array, outArray: Float32Array, min = 0, range = 1): void {
  for (let i = 0; i < inArray.length; i++) {
    outArray[i] += (inArray[i] - min) / range;
  }
}

function vMul(inArray: Float32Array, outArray: Float32Array, fac: number): void {
  for (let i = 0; i < inArray.length; i++) {
    outArray[i] = inArray[i] * fac;
  }
}

// skewSamples: sample-time skew of fft1's stream minus fft2's stream. The
// transfer function H = fft1/fft2 inherits a linear phase -2*pi*k*skew/N from
// any acquisition-time offset between the two channels; we rotate it back out
// so a flat (resistive) network reads ~0 phase. See Listener.streamSampleOffset
// for where the M1K's 0.5-sample chA/chB skew comes from.
function fftMagPhase(
  fft1: FFT,
  fft2: FFT,
  outMag: Float32Array,
  outPhase: Float32Array,
  skewSamples = 0,
): void {
  const r1a = fft1.real;
  const i1a = fft1.imag;
  const r2a = fft2.real;
  const i2a = fft2.imag;

  const log = Math.log;
  const atan2 = Math.atan2;
  const cos = Math.cos;
  const sin = Math.sin;

  const magScale = 10 / Math.LN10; // avoid square root, so an extra power of 2
  const phaseScale = 180 / Math.PI;

  // Per-bin phase rotation that undoes the inter-channel sample skew. The
  // pipeline FFTs the first difference (vDiff) of each channel before the
  // ratio, which flips the effective sign of a raw sample lag; the negative
  // sign here was confirmed empirically against hardware (libsmu/
  // measure_phase.py: skew=-0.40 flattens, +0.40 doubles the ramp).
  const phasePerBin = (-2 * Math.PI * skewSamples) / fft1.bufferSize;

  for (let x = 0; x < fft1.bufferSize / 2; x++) {
    const r1 = r1a[x];
    const i1 = i1a[x];
    const r2 = r2a[x];
    const i2 = i2a[x];
    // Complex number division
    const d = r2 * r2 + i2 * i2;
    let r = (r1 * r2 + i1 * i2) / d;
    let im = (r2 * i1 - r1 * i2) / d;
    if (skewSamples !== 0) {
      // Multiply H by exp(j * phasePerBin * x) to remove the linear phase.
      const c = cos(phasePerBin * x);
      const s = sin(phasePerBin * x);
      const rr = r * c - im * s;
      im = r * s + im * c;
      r = rr;
    }
    outMag[x] = log(r * r + im * im) * magScale;
    outPhase[x] = atan2(im, r) * phaseScale;
  }
}

// --- Signal state ---

interface SignalState {
  stream: Stream | null;
  acc: Float32Array | null;
  fft: FFT | null;
  step_series: Series;
  imp_series: Series;
}

// --- DOM helpers ---

function getEl(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function getInput(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function getSelect(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

// --- App ---

class App {
  time_axis: Axis;
  value_axis: Axis;
  diff_axis: Axis;
  freq_axis: LogAxis;
  gain_axis: Axis;
  phase_axis: Axis;

  source: SignalState;
  sense: SignalState;

  v1: number;
  v2: number;

  mag_series: Series;
  phase_series: Series;

  step_plot: GraphCanvas;
  imp_plot: GraphCanvas;
  mag_plot: GraphCanvas;
  phase_plot: GraphCanvas;

  running: boolean;
  device!: CEEDevice;
  listener: DataListener | null;
  pendingStart: boolean;
  sweepCount: number;
  tdata!: Float32Array;
  fdata!: Float32Array;

  constructor() {
    this.time_axis = new Axis(-0.005, 0.015, 's', true);
    this.value_axis = new Axis(0, 1);
    this.diff_axis = new Axis(-0.01, 0.02);
    this.freq_axis = new LogAxis(0, 4, 'Hz');
    this.gain_axis = new Axis(-45, 45, 'dB');
    this.phase_axis = new Axis(-180, 180, '\u00B0');

    this.source = {
      stream: null,
      acc: null,
      fft: null,
      step_series: new Series([], [], [0, 0, 255]),
      imp_series: new Series([], [], [0, 0, 255]),
    };

    this.sense = {
      stream: null,
      acc: null,
      fft: null,
      step_series: new Series([], [], [255, 0, 0]),
      imp_series: new Series([], [], [255, 0, 0]),
    };

    this.v1 = 0;
    this.v2 = 4;

    this.mag_series = new Series([], [], [0, 0, 0]);
    this.phase_series = new Series([], [], [0, 0, 0]);

    this.step_plot = new GraphCanvas(
      getEl('step_plot'),
      this.time_axis, this.value_axis,
      [this.source.step_series, this.sense.step_series],
      { xbottom: true, yright: false, xgrid: true },
    );

    this.imp_plot = new GraphCanvas(
      getEl('impulse_plot'),
      this.time_axis, this.diff_axis,
      [this.source.imp_series, this.sense.imp_series],
      { xbottom: true, yright: false, xgrid: true },
    );

    this.mag_plot = new GraphCanvas(
      getEl('bode_magnitude_plot'),
      this.freq_axis, this.gain_axis,
      [this.mag_series],
      { xbottom: true, yright: false, xgrid: true },
    );

    this.phase_plot = new GraphCanvas(
      getEl('bode_phase_plot'),
      this.freq_axis, this.phase_axis,
      [this.phase_series],
      { xbottom: true, yright: false, xgrid: true },
    );

    this.running = false;
    this.listener = null;
    this.pendingStart = false;
    this.sweepCount = 0;

    getEl('startpause').addEventListener('click', () => {
      if (!this.running) {
        this.start();
      } else {
        this.stop();
      }
    });

    window.addEventListener('resize', this.resized);

    getEl('export-png').addEventListener('click', () => {
      const which = getSelect('export-png-plot').value;
      const plots: Record<string, { plot: GraphCanvas; title: string; file: string }> = {
        step: { plot: this.step_plot, title: 'Step response (V)', file: 'step-response' },
        impulse: { plot: this.imp_plot, title: 'Impulse response (V)', file: 'impulse-response' },
        magnitude: { plot: this.mag_plot, title: 'Gain (dB)', file: 'gain' },
        phase: { plot: this.phase_plot, title: 'Phase (°)', file: 'phase' },
      };
      const label = getInput('export-png-label').value.trim();
      const keys = which === 'all' ? Object.keys(plots) : [which];

      for (const key of keys) {
        const p = plots[key];
        if (!p) continue;
        // Re-render synchronously so the WebGL trace buffer is populated when
        // snapshotPNG reads it back (no preserveDrawingBuffer).
        p.plot.drawSync();
        snapshotPNG([p.plot.axisCanvas, p.plot.graphCanvas], {
          title: p.title,
          label: label || undefined,
          filename: p.file,
        });
      }
    });

    const paramEls = ['source_stream', 'sense_stream', 'v1', 'v2'];
    for (const id of paramEls) {
      getEl(id).addEventListener('change', this.updateParams);
    }
  }

  initDevice(device: CEEDevice): void {
    this.device = device;
    this.resized();

    this.listener = null;
    this.afterStop();

    const populateStreamSelect = (_device: CEEDevice, sel: HTMLSelectElement, defaultVal: string): void => {
      const beforeVal = sel.value || defaultVal;
      sel.innerHTML = '';
      for (const channelId of Object.keys(_device.channels)) {
        const channel = _device.channels[channelId];
        for (const streamId of Object.keys(channel.streams)) {
          const stream = channel.streams[streamId];
          const option = document.createElement('option');
          option.value = `${channel.id}.${stream.id}`;
          option.textContent = stream.displayName;
          sel.appendChild(option);
        }
      }
      sel.value = beforeVal;
    };

    populateStreamSelect(this.device, getSelect('source_stream'), 'a.v');
    populateStreamSelect(this.device, getSelect('sense_stream'), 'b.v');

    if (!getInput('v1').value) getInput('v1').value = '0.5';
    if (!getInput('v2').value) getInput('v2').value = '4.5';

    this.updateParams();

    if (this.pendingStart) {
      this.pendingStart = false;
      this.start();
    }
  }

  updateParams = (): void => {
    const getStream = (_device: CEEDevice, sel: HTMLSelectElement): Stream => {
      const [chId, sId] = sel.value.split('.');
      return _device.channels[chId].streams[sId];
    };

    this.source.stream = getStream(this.device, getSelect('source_stream'));
    this.sense.stream = getStream(this.device, getSelect('sense_stream'));

    const unitText = this.source.stream.units;
    getEl('v1-unit').textContent = unitText;
    getEl('v2-unit').textContent = unitText;

    this.v1 = parseFloat(getInput('v1').value);
    this.v2 = parseFloat(getInput('v2').value);
  };

  resized = (): void => {
    this.step_plot.resized();
    this.imp_plot.resized();
    this.mag_plot.resized();
    this.phase_plot.resized();
  };

  start = (): void => {
    this.running = true;
    document.body.classList.add('capturing');
    getEl('startpause').setAttribute('title', 'Stop');

    const disableIds = ['source_stream', 'sense_stream', 'v1', 'v2'];
    for (const id of disableIds) {
      (getEl(id) as HTMLInputElement | HTMLSelectElement).disabled = true;
    }

    const targetSampleTime = 1 / 80e3;
    if (this.device.sampleTime !== targetSampleTime) {
      console.log('Setting sample rate');
      this.device.configure({ sampleTime: targetSampleTime });
      // Wait for the server to reconfigure the device, then start it
      this.pendingStart = true;
      return;
    }

    this.device.startCapture();

    this.sweepCount = 0;

    const sampleTime = this.device.sampleTime;

    this.time_axis.min = -sampleScale * stepTimeRatio * sampleTime;
    this.time_axis.max = sampleScale * (1 - stepTimeRatio) * sampleTime;
    // arange() returns a plain number[], but the GL buffer needs a Float32Array
    // (a number[] silently produces a zero-length buffer). It also includes the
    // endpoint, yielding sampleScale + 1 points, so trim x to match the
    // sampleScale-long y buffers.
    this.tdata = Float32Array.from(
      arange(this.time_axis.min, this.time_axis.max, this.device.sampleTime),
    ).subarray(0, sampleScale);

    this.time_axis.visibleMin = this.time_axis.min * 0.1;
    this.time_axis.visibleMax = this.time_axis.max * 0.3;

    this.freq_axis.visibleMin = this.freq_axis.min = 0;
    this.fdata = new Float32Array(sampleScale / 2);
    for (let i = 0; i < sampleScale / 2; i++) {
      this.fdata[i] = Math.max(0, Math.log(i / sampleTime / sampleScale)) / Math.LN10;
    }
    // fdata holds log10(frequency); its last entry is the Nyquist frequency
    // (~40 kHz at 80 ksps). Show the full range rather than clamping at 10^4 Hz.
    this.freq_axis.visibleMax = this.freq_axis.max = this.fdata[this.fdata.length - 1];

    const initSignal = (s: SignalState): void => {
      s.step_series.xdata = this.tdata;
      s.imp_series.xdata = this.tdata;

      s.step_series.ydata = new Float32Array(sampleScale);
      s.imp_series.ydata = new Float32Array(sampleScale);

      s.acc = new Float32Array(sampleScale);
      s.fft = new FFT(sampleScale, 1 / this.device.sampleTime);
    };

    this.mag_series.xdata = this.fdata;
    this.mag_series.ydata = new Float32Array(sampleScale / 2);

    this.phase_series.xdata = this.fdata;
    this.phase_series.ydata = new Float32Array(sampleScale / 2);

    initSignal(this.source);
    initSignal(this.sense);

    if (this.source.stream!.parent !== this.sense.stream!.parent) {
      // if measuring from another channel than the source, allow sense channel to float
      this.sense.stream!.parent.setConstant('0', 0);
    }

    this.step_plot.needsRedraw(true);
    this.imp_plot.needsRedraw(true);
    this.mag_plot.needsRedraw(true);
    this.phase_plot.needsRedraw(true);

    const sourceStream = this.source.stream!;
    const senseStream = this.sense.stream!;

    sourceStream.parent.set(sourceStream.outputMode, 'arb', {
      values: [
        { t: 0, v: this.v1 },
        { t: stepTimeRatio * sampleScale, v: this.v1 },
        { t: stepTimeRatio * sampleScale, v: this.v2 },
        { t: 1 * sampleScale, v: this.v2 },
        { t: 1.25 * sampleScale, v: this.v1 },
        { t: 2 * sampleScale, v: this.v1 }, // the period > the requested length, so bug isn't triggered
      ],
      phase: 0,
      relPhase: 0,
      repeat: -1,
    }, (d) => {
      const listener = new DataListener(this.device, [sourceStream, senseStream]);
      this.listener = listener;
      // Access protected members directly for low-level listener configuration
      (listener as unknown as Record<string, number>).startSample =
        (d.startSample as number) + 1;
      (listener as unknown as Record<string, number>).len = sampleScale;
      listener.count = sampleScale;
      listener.decimateFactor = 1;
      listener.trigger = {
        type: 'out',
        stream: sourceStream,
        level: 0,
        holdoff: 0,
        offset: 0,
        force: 0,
      };
      listener.submit();
      listener.sweepDone.listen(this.handleData);
    });
  };

  handleData = (): void => {
    const listener = this.listener!;
    const [data1, data2] = listener.data;

    this.sweepCount += 1;
    const updateUI = this.sweepCount % 4 === 2;

    const processSignal = (s: SignalState, d: Float32Array): void => {
      vAccumulate(d, s.acc!, s.stream!.min, s.stream!.max - s.stream!.min);

      if (updateUI) {
        vMul(s.acc!, s.step_series.ydata as Float32Array, 1 / this.sweepCount);
        vDiff(s.step_series.ydata as Float32Array, s.imp_series.ydata as Float32Array);
        s.fft!.forward(s.imp_series.ydata as Float32Array);
      }
    };

    processSignal(this.source, data1);
    processSignal(this.sense, data2);

    if (updateUI) {
      // fft1 = sense, fft2 = source, so H = sense/source; pass the sense-minus-
      // source acquisition skew so the inter-channel offset is rotated out.
      const skew = listener.streamSampleOffset(this.sense.stream!)
        - listener.streamSampleOffset(this.source.stream!);
      fftMagPhase(
        this.sense.fft!, this.source.fft!,
        this.mag_series.ydata as Float32Array,
        this.phase_series.ydata as Float32Array,
        skew,
      );

      this.step_plot.needsRedraw();
      this.imp_plot.needsRedraw();
      this.mag_plot.needsRedraw();
      this.phase_plot.needsRedraw();

      getEl('samplecount').textContent = String(this.sweepCount);
    }
  };

  stop = (): void => {
    this.device.pauseCapture();
  };

  afterStop(): void {
    document.body.classList.remove('capturing');
    getEl('startpause').setAttribute('title', 'Start');

    const enableIds = ['source_stream', 'sense_stream', 'v1', 'v2'];
    for (const id of enableIds) {
      (getEl(id) as HTMLInputElement | HTMLSelectElement).disabled = false;
    }

    this.running = false;

    if (this.listener) {
      this.listener.cancel();
      this.listener = null;
    }
  }
}

// --- Entry point ---

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();

  initSession({
    app: 'Pixelpulse DSA',
    model: ['com.nonolithlabs.cee', 'com.analogdevices.m1k', 'org.pixelpulse.audio'],
    updateMessage: 'This app may not work with older versions',

    reset: () => {
      // no-op
    },

    updateDevsMenu: (l) => {
      const switchDev = document.getElementById('switchDev');
      if (switchDev) {
        switchDev.style.display = l.length > 1 ? '' : 'none';
      }
    },

    initDevice: (dev) => {
      (dev as CEEDevice).captureStateChanged.listen((s: boolean) => {
        if (!s) app.afterStop();
      });
    },

    deviceChanged: (dev) => {
      app.initDevice(dev as CEEDevice);
    },

    deviceRemoved: () => {
      // no-op
    },
  });
});
