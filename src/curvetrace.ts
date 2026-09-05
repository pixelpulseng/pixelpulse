/**
 * Curve tracer application
 * Ported from curvetrace.coffee
 * Original: (C) Nonolith Labs
 */

import { DataListener, type CEEDevice, type OutputSource } from './dataserver.js';
import { Axis, Series, GraphCanvas } from './livegraph.js';
import { initSession } from './session.js';
import { downloadCSV } from './export.js';

// --- Local helpers ---

function sign(x: number): number {
  return x > 0 ? 1 : -1;
}

function vAccumulate(inArray: Float32Array, outArray: Float32Array): void {
  for (let i = 0; i < inArray.length; i++) {
    outArray[i] += inArray[i];
  }
}

function vMul(inArray: Float32Array, outArray: Float32Array, fac: number): void {
  for (let i = 0; i < inArray.length; i++) {
    outArray[i] = inArray[i] * fac;
  }
}

// --- Buffered signal data ---

interface SignalData {
  acc: Float32Array;
  data: Float32Array;
}

// --- App ---

class App {
  private readonly divider = 10;
  private readonly targetSampleTime = 1 / 40e3;
  private readonly sweepDuration = 0.1;
  private readonly sampleCt: number;

  private readonly currentAxis: Axis;
  private readonly voltageAxis: Axis;
  private readonly curveTraceData: Series;
  private readonly curveTrace: GraphCanvas;

  private vd: SignalData;
  private id: SignalData;

  private running = false;
  private pendingStart = false;
  private sweepCount = 0;
  private device: CEEDevice | null = null;
  private listener: DataListener | null = null;

  constructor() {
    this.sampleCt = this.sweepDuration * 4 * (1 / this.targetSampleTime) / this.divider;

    this.currentAxis = new Axis(-200, 200, 'mA');
    this.voltageAxis = new Axis(-5, 5, 'V');
    this.currentAxis.visibleMin = this.currentAxis.min = -200;
    this.currentAxis.visibleMax = this.currentAxis.max = 200;

    this.curveTraceData = new Series(
      new Float32Array(0),
      new Float32Array(0),
      [0, 0, 255],
    );

    this.vd = {
      acc: new Float32Array(this.sampleCt),
      data: new Float32Array(this.sampleCt),
    };
    this.id = {
      acc: new Float32Array(this.sampleCt),
      data: new Float32Array(this.sampleCt),
    };

    const curveTraceEl = document.getElementById('curve_trace');
    if (!curveTraceEl) throw new Error('Missing #curve_trace element');

    this.curveTrace = new GraphCanvas(
      curveTraceEl,
      this.voltageAxis,
      this.currentAxis,
      [this.curveTraceData],
      { xbottom: true, yright: false, xgrid: true },
    );

    const startPauseBtn = document.getElementById('startpause');
    if (startPauseBtn) {
      startPauseBtn.addEventListener('click', () => {
        if (!this.running) {
          this.start();
        } else {
          this.stop();
        }
      });
    }

    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this.exportCSV());
    }

    window.addEventListener('resize', () => this.resized());
  }

  initDevice(device: CEEDevice): void {
    this.device = device;
    this.resized();

    this.listener = null;
    this.afterStop();

    if (this.pendingStart) {
      this.pendingStart = false;
      this.start();
    }
  }

  private resized(): void {
    this.curveTrace.resized();
  }

  private start(): void {
    if (!this.device) return;

    this.running = true;
    document.body.classList.add('capturing');

    const startPauseBtn = document.getElementById('startpause');
    if (startPauseBtn) startPauseBtn.setAttribute('title', 'Stop');

    if (this.device.sampleTime !== this.targetSampleTime) {
      this.device.configure({ sampleTime: this.targetSampleTime });
      this.pendingStart = true;
      return;
    }

    this.sweepCount = 0;

    const sampleTime = this.device.sampleTime;

    this.curveTraceData.xdata = new Float32Array(this.sampleCt);
    this.curveTraceData.ydata = new Float32Array(this.sampleCt);

    const initSignal = (): SignalData => ({
      acc: new Float32Array(this.sampleCt),
      data: new Float32Array(this.sampleCt),
    });

    this.vd = initSignal();
    this.id = initSignal();

    this.curveTrace.needsRedraw(true);

    this.device.channels.b.set('1', 'arb', {
      values: [
        { t: 0, v: 0 },
        { t: 2 * this.sweepDuration * (1 / sampleTime), v: 0 },
        { t: 3 * this.sweepDuration * (1 / sampleTime), v: 5 },
        { t: 4 * this.sweepDuration * (1 / sampleTime), v: 0 },
      ],
      phase: 0,
      relPhase: 0,
      repeat: -1,
    });

    this.device.channels.a.set('1', 'arb', {
      values: [
        { t: 0, v: 0 },
        { t: 1 * this.sweepDuration * (1 / sampleTime), v: 5 },
        { t: 2 * this.sweepDuration * (1 / sampleTime), v: 0 },
        { t: 4 * this.sweepDuration * (1 / sampleTime), v: 0 },
      ],
      phase: 0,
      relPhase: 0,
      repeat: -1,
    }, (d: OutputSource) => {
      if (!this.device) return;

      const listener = new DataListener(this.device, [
        this.device.channels.a.streams.v,
        this.device.channels.a.streams.i,
        this.device.channels.b.streams.v,
        this.device.channels.b.streams.i,
      ]);

      // These fields are protected in the base class; use type assertion for migration compatibility
      const listenerInternal = listener as unknown as {
        startSample: number;
        len: number;
        count: number;
        decimateFactor: number;
        trigger: unknown;
      };
      listenerInternal.startSample = ((d as unknown as Record<string, number>).startSample ?? 0) + 1;
      listenerInternal.len = this.sampleCt;
      listenerInternal.count = this.sampleCt;
      listenerInternal.decimateFactor = this.divider;
      listenerInternal.trigger = {
        type: 'out',
        stream: this.device.channels.a.streams.v,
        holdoff: 0,
        offset: 0,
        force: 0,
      };

      listener.submit();
      listener.sweepDone.listen(() => this.handleData());

      this.listener = listener;
    });

    this.device.startCapture();
  }

  private handleData(): void {
    if (!this.listener) return;

    const [av, ai, bv, bi] = this.listener.data;
    this.sweepCount += 1;
    const updateUI = this.sweepCount % 4 === 2;

    for (let i = 0; i <= av.length; i++) {
      this.vd.data[i] = av[i] - bv[i];
      if (av[i] > bv[i]) {
        this.id.data[i] = sign(ai[i]) * Math.abs(bi[i]);
      }
      if (bv[i] > av[i]) {
        this.id.data[i] = sign(ai[i]) * Math.abs(ai[i]);
      }
    }

    vAccumulate(this.id.data, this.id.acc);
    vAccumulate(this.vd.data, this.vd.acc);

    if (updateUI) {
      vMul(this.id.acc, this.curveTraceData.ydata as Float32Array, 1 / this.sweepCount);
      vMul(this.vd.acc, this.curveTraceData.xdata as Float32Array, 1 / this.sweepCount);
      this.curveTrace.needsRedraw();

      const sampleCountEl = document.getElementById('samplecount');
      if (sampleCountEl) sampleCountEl.textContent = String(this.sweepCount);
    }
  }

  private exportCSV(): void {
    if (!this.sweepCount) {
      alert('No data to export');
      return;
    }

    downloadCSV([
      { name: 'Voltage', units: 'V', precision: 4, data: Array.from(this.curveTraceData.xdata) },
      { name: 'Current', units: 'mA', precision: 4, data: Array.from(this.curveTraceData.ydata) },
    ]);
  }

  private stop(): void {
    if (!this.device) return;
    this.device.pauseCapture();
  }

  afterStop(): void {
    document.body.classList.remove('capturing');

    const startPauseBtn = document.getElementById('startpause');
    if (startPauseBtn) startPauseBtn.setAttribute('title', 'Start');

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
    app: 'Pixelpulse Curve Tracer',
    model: ['com.nonolithlabs.cee', 'com.analogdevices.m1k'],
    updateMessage: 'This app may not work with older versions',

    reset(): void {
      // no-op
    },

    updateDevsMenu(l): void {
      const switchDevEl = document.getElementById('switchDev');
      if (switchDevEl) {
        switchDevEl.style.display = l.length > 1 ? '' : 'none';
      }
    },

    initDevice(dev): void {
      const ceeDevice = dev as CEEDevice;
      ceeDevice.pauseCapture();
      ceeDevice.captureStateChanged.listen((s: boolean) => {
        if (!s) app.afterStop();
      });
    },

    deviceChanged(dev): void {
      app.initDevice(dev as CEEDevice);
    },

    deviceRemoved(): void {
      // no-op
    },
  });
});
