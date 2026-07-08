/**
 * Time-series graph data listener and graph views
 * Ported from livegraph_data_listener.coffee
 * Original: (C) Nonolith Labs
 */

import {
  type CEEDevice, type Stream, type OutputSource, type UpdateMessage,
  DataListener, server, TypedEvent,
} from './dataserver.js';
import {
  Axis, Series, GraphCanvas, Dot, TriggerOverlay,
  Action, DragScrollAction, AnimateXAction, ZoomXAction,
  makeTransform, invTransform,
} from './livegraph.js';

// --- DataSeries: binds listener buffer data to a Series ---

export class DataSeries extends Series {
  updated: TypedEvent<[UpdateMessage]>;

  constructor(
    public listener: DataListener,
    public xseries: 'time' | Stream,
    public yseries: Stream,
  ) {
    super(
      xseries === 'time' ? listener.xdata : listener.data[listener.streamIndex(xseries)],
      listener.data[listener.streamIndex(yseries)],
      [0, 0, 0],
    );
    this.updated = listener.updated;
    listener.reset.subscribe(this.reset);
    this.reset();
  }

  private reset = (): void => {
    this.xdata = this.xseries === 'time'
      ? this.listener.xdata
      : this.listener.data[this.listener.streamIndex(this.xseries as Stream)];
    this.ydata = this.listener.data[this.listener.streamIndex(this.yseries)];
  };
}

// --- Flags (parsed from URL hash) ---

interface Flags {
  outputTrigger: boolean;
}

function parseFlags(): Flags {
  const hash = document.location.hash;
  return {
    outputTrigger: hash.includes('outputTrigger'),
  };
}

const flags = parseFlags();

// --- TimeseriesGraphListener ---

export class TimeseriesGraphListener extends DataListener {
  xaxis: Axis;
  graphs: TimeseriesGraph[] = [];
  triggerOverlay: TriggerOverlay | null = null;
  private updatePending = false;
  phosphorRaw = false; // true: request undecimated samples for density rendering
  // Optional observer for x-axis window changes (used to keep the shareable
  // URL in sync). Set by views.ts; kept as a plain callback to avoid a
  // layering dependency on share-state here.
  onWindowChanged: (() => void) | null = null;

  constructor(device: CEEDevice, streams: Stream[], graphs: TimeseriesGraph[] = []) {
    super(device, streams);
    this.graphs = graphs;
    this.xaxis = new Axis(-10, 0, 's', true);
    this.xaxis.windowChanged = this.checkWindowChange;
  }

  makeGraph(stream: Stream, elem: HTMLElement, color: [number, number, number]): TimeseriesGraph {
    console.assert(this.streams.includes(stream), 'stream', stream, 'not in', this.streams);
    const g = new TimeseriesGraph(this, stream, elem, color);
    this.graphs.push(g);
    return g;
  }

  queueWindowUpdate(): void {
    if (!this.updatePending) {
      setTimeout(() => this.updateWindow(), 10);
      this.updatePending = true;
    }
  }

  updateWindow = (min?: number, max?: number): void => {
    this.updatePending = false;
    const lg = this.graphs[0];
    if (!lg?.width) return;

    min ??= this.xaxis.visibleMin;
    max ??= this.xaxis.visibleMax;
    const span = max - min;

    if (this.trigger) {
      this.trigger.holdoff = Math.max(0, 0.1 - span);
    } else {
      min = Math.max(min - 0.4 * span, this.xaxis.min);
      max = Math.min(max + 0.4 * span, this.xaxis.max);
    }

    let pts = lg.width / 2 * (max - min) / span;
    if (this.phosphorRaw) {
      // Request raw samples up to what the screen can actually depict:
      // density resolution saturates around a couple hundred samples per
      // pixel column. Beyond that, fall back to (averaged) decimation.
      const rawPts = (max - min) / this.device.sampleTime;
      const budget = Math.min(lg.width * 256, 250000);
      pts = Math.min(rawPts, budget);
    }
    this.configure(min, max, pts);
    this.submit();
  };

  private checkWindowChange = (min: number, max: number, _done?: boolean, target?: [number, number]): void => {
    const lg = this.graphs[0];

    if (target) {
      // A pending zoom target that's still shrinking toward its goal — ignore
      // this intermediate frame entirely (don't notify observers of a window
      // that was never committed).
      if ((target[1] - target[0]) < 0.5 * (max - min)) return;
      [min, max] = target;
    }

    // The window is settling on (min,max); observers (share-state URL sync)
    // see only committed windows, not discarded mid-animation frames.
    this.onWindowChanged?.();

    const span = max - min;

    if (
      ((this.xmax < max || this.xmin > min)
        && max <= this.xaxis.max && min >= this.xaxis.min)
      || span / (this.xmax - this.xmin) * this.requestedPoints < 0.45 * lg.width
    ) {
      this.updateWindow(min, max);
    }
  };

  goToWindow(min: number, max: number, animate = true): AnimateXAction | void {
    if (animate) {
      return new AnimateXAction({ time: 200 }, this.graphs[0], min, max, this.graphs);
    } else {
      this.xaxis.window(min, max, true);
      this.redrawAll(true);
    }
  }

  redrawAll(full = false): void {
    for (const lg of this.graphs) {
      lg.needsRedraw(full);
    }
  }

  override onMessage(m: UpdateMessage): void {
    super.onMessage(m);
    this.redrawAll();
  }

  cancelAllActions(): void {
    for (const lg of this.graphs) {
      lg.startAction();
    }
  }

  zoomCompletelyOut(animate = true): AnimateXAction | void {
    return this.goToWindow(this.xaxis.min, this.xaxis.max, animate);
  }

  fakeAutoset(animate = true): AnimateXAction | void {
    if (!this.trigger) return;
    const src = this.trigger.stream.parent.source;
    const sampleTime = this.device.sampleTime;
    const f = 2;

    let timescale: number;
    switch (src.source) {
      case 'adv_square':
        timescale = ((src.highSamples ?? 0) + (src.lowSamples ?? 0)) * sampleTime * f;
        break;
      case 'sine': case 'triangle': case 'square': case 'arb':
        timescale = (src.period ?? 1) * sampleTime * f;
        break;
      default:
        timescale = 0.5;
    }

    return this.goToWindow(
      Math.max(this.xaxis.min, -timescale),
      Math.min(this.xaxis.max, timescale),
      animate,
    );
  }

  autozoom(): void {
    if (this.trigger) {
      this.fakeAutoset();
    } else {
      this.zoomCompletelyOut();
    }
  }

  canChangeView(): boolean {
    return !!this.trigger || !(server.device as CEEDevice | null)?.captureState;
  }

  updateDotsAll(): void {
    for (const g of this.graphs) {
      g.updateDots();
    }
  }

  isTriggerEnabled(): boolean {
    return !!this.trigger;
  }

  enableTrigger(): void {
    this.xaxis.min = -1;
    this.xaxis.max = 1;

    for (const lg of this.graphs) {
      lg.showXgridZero = true;
      // Full time grid in triggered mode: drag handles snap to it, so
      // V/I ratios and periods can be read off the gridlines
      lg.showXgrid = true;
    }

    const defaultTriggerLevel = 2.5;
    const tp = flags.outputTrigger ? 'out' : 'in';

    this.configureTrigger(this.streams[0], defaultTriggerLevel, 0.1, 0, 0.5, tp);
    this.triggerOverlay = new TriggerOverlay(this.graphs[0]);
    this.triggerOverlay.position(defaultTriggerLevel);
    this.setTrigger(this.streams[0], defaultTriggerLevel, false);
    this.fakeAutoset(false);
  }

  dragTrigger(stream: Stream, level?: number): void {
    if (stream.isSource() && this.device.hasOutTrigger) {
      if (this.trigger) {
        this.trigger.level = stream.sourceLevel();
        level = this.trigger.level;
      }
    }

    if (level != null) {
      this.triggerOverlay?.position(level);
    }
  }

  updateTriggerForOutput(): void {
    if (!this.trigger) return;
    const stream = this.trigger.stream;

    if (stream.isSource() !== (this.trigger.type === 'out') && this.device.hasOutTrigger) {
      this.setTrigger(stream, this.trigger.level);
    }

    this.dragTrigger(stream);
  }

  setTrigger(stream: Stream, level = 0, submit = true): void {
    if (!this.trigger) return;
    this.trigger.stream = stream;
    this.trigger.level = level;

    if (stream.isSource() && this.device.hasOutTrigger) {
      this.trigger.force = 10;
      this.trigger.type = 'out';
    } else {
      this.trigger.force = 0.5;
      this.trigger.type = 'in';
    }

    this.dragTrigger(stream, level);
    if (submit) this.submit();

    if (this.trigger.type === 'in') {
      this.triggerOverlay?.style('#ffaa00', 1);
    } else {
      this.triggerOverlay?.style('#22aa00', 0);
    }

    this.updateDotsAll();
  }

  override disableTrigger(): void {
    this.xaxis.min = -10;
    this.xaxis.max = 0;
    this.xaxis.window(-10, 0, true);
    for (const lg of this.graphs) {
      lg.showXgridZero = false;
      lg.showXgrid = false;
    }
    this.triggerOverlay?.remove();
    this.triggerOverlay = null;
    super.disableTrigger();
    this.updateDotsAll();
    this.redrawAll(true);
  }
}

// --- TimeseriesGraph ---

export class TimeseriesGraph extends GraphCanvas {
  yaxis: Axis;
  dseries: DataSeries;
  stream: Stream;
  dots: Record<string, Dot> = {};
  dotConfig = '';

  constructor(
    public timeseries: TimeseriesGraphListener,
    stream: Stream,
    elem: HTMLElement,
    color: [number, number, number],
  ) {
    const yaxis = new Axis(stream.min, stream.max, stream.units, true);

    if (stream.units === 'mA') {
      yaxis.prescale = 1000;
      yaxis.unit = 'A';
    } else {
      yaxis.prescale = 1;
    }

    const dseries = new DataSeries(timeseries, 'time', stream);
    dseries.color = color;

    super(elem, timeseries.xaxis, yaxis, [dseries]);

    this.yaxis = yaxis;
    this.dseries = dseries;
    this.stream = stream;
    this.onResized = () => this.timeseries.queueWindowUpdate();

    timeseries.updated.subscribe(this.onPhosphorData);
    timeseries.reset.subscribe(() => { this.phosphorNeedsFull = true; });
  }

  // Incremental phosphor deposit: each sample is added to the accumulator
  // exactly once when it arrives, so brightness is a true density count.
  // In scrolling mode the accumulator is shifted left in step with the data.
  private onPhosphorData = (m: UpdateMessage): void => {
    if (!this.phosphorEnabled || !this.phosphor || this.phosphorNeedsFull || !this.phosphorTransform) {
      return;
    }
    const arr = m.data[this.timeseries.streamIndex(this.stream)];
    const n = arr?.length ?? 0;
    if (!n) return;

    const [sx, sy, dx, dy] = this.phosphorTransform;
    const xdata = this.dseries.xdata as Float32Array;
    const ydata = this.dseries.ydata as Float32Array;

    if (!this.timeseries.trigger && this.timeseries.xmin < 0) {
      // Scrolling: history moves left with the data; new samples land at
      // the right edge. Fractional pixel shifts are carried over.
      this.phosphorShiftCarry += n * this.timeseries.sampleTime * sx;
      const shift = Math.floor(this.phosphorShiftCarry);
      if (shift > 0) {
        this.phosphor.shiftLeft(shift);
        this.phosphorShiftCarry -= shift;
      }
      const start = Math.max(0, ydata.length - n - 1); // -1: line continuity
      this.phosphor.scatter(xdata.subarray(start), ydata.subarray(start), sx, sy, dx, dy, this.geom, true);
    } else {
      // Sweep mode: deposit the newly arrived chunk in place
      const start = Math.max(0, m.idx - 1);
      const end = Math.min(xdata.length, ydata.length, m.idx + n);
      if (end > start) {
        this.phosphor.scatter(xdata.subarray(start, end), ydata.subarray(start, end), sx, sy, dx, dy, this.geom, true);
      }
    }
  };

  // Full re-scatter (transform change / buffer rebuild): only the region of
  // the buffer that holds real samples — the zero-initialized remainder
  // would deposit a false line at y=0.
  protected override phosphorFullScatter([sx, sy, dx, dy]: [number, number, number, number]): void {
    if (!this.phosphor) return;
    const [j0, j1] = this.timeseries.validRange();
    const xdata = this.dseries.xdata as Float32Array;
    const ydata = this.dseries.ydata as Float32Array;
    const start = Math.max(0, j0);
    const end = Math.min(j1, xdata.length, ydata.length);
    if (end > start) {
      this.phosphor.scatter(xdata.subarray(start, end), ydata.subarray(start, end), sx, sy, dx, dy, this.geom);
    }
  }

  override onClick(pos: [number, number], _e: MouseEvent): void {
    const [x, y] = pos;

    // Wave/square handle drags snap to the drawn gridlines: scrubbing
    // steps through round values, and with phosphor persistence each step
    // leaves a distinct trace (eyeball impedance vs frequency, V/I ratio
    // vs amplitude, against the grid).
    if (this.dotConfig === 'wave' && this.dots.offset?.isNear(x, y, 10)) {
      new DragDotAction(this, pos, (lg, _x, y) => {
        lg.stream.parent.setAdjust({ offset: lg.snapY(y) });
      });
    } else if (this.dotConfig === 'wave' && this.dots.period?.isNear(x, y, 10)) {
      new DragDotAction(this, pos, (lg, x, y) => {
        const sx = lg.snapX(x);
        // Clamp at zero: dragging below the offset would silently set a
        // negative amplitude, inverting the waveform's phase relative to
        // the drag handles
        const amplitude = Math.max(0, lg.snapY(y) - (lg.stream.parent.source.offset ?? 0));
        // Don't let a snap to x<=0 collapse the period
        const px = sx > 0 ? sx : x;
        const period = Math.max(5, px * 4 / (server.device as CEEDevice).sampleTime);
        lg.stream.parent.setAdjust({ amplitude, period });
      });
    } else if (this.dotConfig === 'square' && this.dots.v1?.isNear(x, y, 10)) {
      new DragDotAction(this, pos, (lg, x, y) => {
        const { highSamples = 0, lowSamples = 0 } = lg.stream.parent.source;
        const period = highSamples + lowSamples;
        const sx = lg.snapX(x);
        const px = sx > 0 ? sx : x;
        const xAdj = Math.max(0, Math.min(period - 1, px / (server.device as CEEDevice).sampleTime)) + 1;
        lg.stream.parent.setAdjust({
          high: lg.snapY(y),
          highSamples: Math.round(xAdj),
          lowSamples: period - Math.round(xAdj),
          dutyCycleHint: xAdj / period,
        });
      });
    } else if (this.dotConfig === 'square' && this.dots.v2?.isNear(x, y, 10)) {
      new DragDotAction(this, pos, (lg, x, y) => {
        const { dutyCycleHint = 0.5 } = lg.stream.parent.source;
        const sx = lg.snapX(x);
        const px = sx > 0 ? sx : x;
        const newPeriod = Math.round(Math.max(2, px / (server.device as CEEDevice).sampleTime + 1));
        lg.stream.parent.setAdjust({
          highSamples: Math.round(dutyCycleHint * newPeriod),
          lowSamples: Math.round((1 - dutyCycleHint) * newPeriod),
          low: lg.snapY(y),
          dutyCycleHint,
        });
      });
    } else if (x > this.width - 45) {
      new DragDotAction(this, pos, (lg, _x, y) => {
        lg.stream.parent.setConstant(lg.stream.outputMode, y);
      });
    } else if (x < 45 && this.timeseries.trigger) {
      if (this.timeseries.trigger.stream !== this.stream) {
        this.timeseries.triggerOverlay?.remove();
        this.timeseries.triggerOverlay = new TriggerOverlay(this);
        this.timeseries.setTrigger(this.stream, 0, false);
      }
      new DragTriggerAction(this, pos);
    } else if (this.timeseries.canChangeView()) {
      new DragScrollAction(this, pos, this.timeseries.graphs);
    }
  }

  override onDblClick(e: MouseEvent, pos: [number, number], btn: number): void {
    if (!this.timeseries.canChangeView()) return;
    const zf = (e.shiftKey || btn === 2) ? 2 : 0.5;

    if (zf < 1 && this.timeseries.xaxis.span() < 40 * this.timeseries.device.sampleTime) {
      return;
    }

    new ZoomXAction({ time: 200, zoomFactor: zf }, this, pos, this.timeseries.graphs);
  }

  resetDots(t: string): boolean {
    if (this.dotConfig !== t) {
      for (const dot of Object.values(this.dots)) {
        dot.remove();
      }
      this.dots = {};
      this.dotConfig = t;
      return true;
    }
    return false;
  }

  updateDots(): void {
    const trigger = this.timeseries.trigger;
    const isTriggerStream = trigger && trigger.stream === this.stream;
    const isSource = this.stream.isSource();
    const s = this.stream.parent.source;
    const sampleTime = (server.device as CEEDevice).sampleTime;

    if (isSource && s.source === 'constant') {
      if (this.resetDots('constant')) {
        this.dots.d = new Dot(this, this.dseries.cssColor(), 5, 'r');
      }
      this.dots.d.position(null, s.value ?? 0);
    } else if (isSource && (server.device as CEEDevice)?.hasOutTrigger && isTriggerStream) {
      if (['sine', 'triangle', 'square'].includes(s.source)) {
        if (this.resetDots('wave')) {
          this.dots.offset = new Dot(this, this.dseries.cssColor(), 5, false);
          this.dots.period = new Dot(this, this.dseries.cssColor(), 5, false);
        }
        this.dots.offset.position(0, s.offset ?? 0);
        this.dots.period.position(
          (s.period ?? 0) * sampleTime / 4,
          (s.offset ?? 0) + (s.amplitude ?? 0),
        );
      } else if (s.source === 'adv_square') {
        if (this.resetDots('square')) {
          this.dots.v1 = new Dot(this, this.dseries.cssColor(), 5, false);
          this.dots.v2 = new Dot(this, this.dseries.cssColor(), 5, false);
        }
        this.dots.v1.position(((s.highSamples ?? 0) - 1) * sampleTime, s.high ?? 0);
        this.dots.v2.position(
          ((s.highSamples ?? 0) + (s.lowSamples ?? 0) - 1) * sampleTime,
          s.low ?? 0,
        );
      } else {
        this.resetDots('');
      }
    } else {
      this.resetDots('');
    }
  }

  sourceChanged(_isSource: boolean, _m: OutputSource): void {
    this.updateDots();
    const trig = this.timeseries.trigger;
    if (trig && trig.stream === this.stream) {
      this.timeseries.updateTriggerForOutput();
    }
  }

  gainChanged(g: number): void {
    this.yaxis.window(this.yaxis.min / g, this.yaxis.max / g, true);
    this.needsRedraw(true);
  }

}

// --- DragDotAction ---

type DragDotCallback = (lg: TimeseriesGraph, x: number, y: number) => void;

class DragDotAction extends Action {
  private withPos: DragDotCallback;
  protected transformData: ReturnType<typeof makeTransform>;

  constructor(lg: TimeseriesGraph, pos: [number, number], fn?: DragDotCallback) {
    super(lg, pos);
    this.withPos = fn ?? (() => {});
    lg.startDrag(pos);
    this.transformData = makeTransform(lg.geom, lg.xaxis, lg.yaxis);
    this.onDrag(pos);
  }

  override onDrag([x, y]: [number, number]): void {
    const [ux, uy] = invTransform(x, y, this.transformData);
    const lg = this.lg as TimeseriesGraph;
    const clampedY = Math.min(Math.max(uy, lg.stream.min), lg.stream.max);
    this.withPos(lg, ux, clampedY);
  }
}

// --- DragTriggerAction ---

class DragTriggerAction extends DragDotAction {
  private lastY = 0;

  constructor(lg: TimeseriesGraph, pos: [number, number]) {
    super(lg, pos, (lg, _x, y) => {
      (lg as TimeseriesGraph).timeseries.dragTrigger(lg.stream, y);
    });
  }

  override onDrag(pos: [number, number]): void {
    super.onDrag(pos);
    const [, uy] = invTransform(pos[0], pos[1], this.transformData);
    const lg = this.lg as TimeseriesGraph;
    this.lastY = Math.min(Math.max(uy, lg.stream.min), lg.stream.max);
  }

  override onRelease(): void {
    const lg = this.lg as TimeseriesGraph;
    lg.timeseries.setTrigger(lg.stream, this.lastY);
  }
}

// --- XYGraphView ---

export interface StreamSelectElement extends HTMLSelectElement {
  stream: () => Stream;
  selectStream: (s: Stream) => void;
}

export class XYGraphView {
  graphdiv: HTMLDivElement;
  xlabel: StreamSelectElement;
  ylabel: StreamSelectElement;
  lg: GraphCanvas;
  xaxis!: Axis;
  yaxis!: Axis;
  xstream!: Stream;
  ystream!: Stream;
  series!: DataSeries;
  color: [number, number, number] = [255, 0, 0];

  private timeseries: TimeseriesGraphListener;

  constructor(
    public el: HTMLElement,
    timeseries: TimeseriesGraphListener,
    makeStreamSelect: () => StreamSelectElement,
    layoutChanged: TypedEvent,
  ) {
    this.timeseries = timeseries;

    this.graphdiv = document.createElement('div');
    this.graphdiv.className = 'livegraph';
    el.appendChild(this.graphdiv);

    this.xlabel = makeStreamSelect();
    this.xlabel.classList.add('xaxislabel');
    el.appendChild(this.xlabel);
    this.xlabel.addEventListener('change', this.axisSelectChanged);

    this.ylabel = makeStreamSelect();
    this.ylabel.classList.add('yaxislabel');
    el.appendChild(this.ylabel);
    this.ylabel.addEventListener('change', this.axisSelectChanged);

    this.lg = new GraphCanvas(this.graphdiv, null as unknown as Axis, null as unknown as Axis, [null as unknown as Series], {
      xbottom: true, yright: false, xgrid: true,
    });

    this._layoutChanged = layoutChanged;
  }

  private _layoutChanged: TypedEvent;

  private axisSelectChanged = (): void => {
    const xaxis = this.xlabel.stream();
    const yaxis = this.ylabel.stream();
    if (xaxis !== this.xstream || yaxis !== this.ystream) {
      this.configure(xaxis, yaxis);
    }
  };

  configure(xstream: Stream, ystream: Stream): void {
    this.xstream = xstream;
    this.ystream = ystream;
    this.xaxis = new Axis(xstream.min, xstream.max);
    this.yaxis = new Axis(ystream.min, ystream.max);

    this.lg.xaxis = this.xaxis;
    this.lg.yaxis = this.yaxis;

    this.xlabel.selectStream(xstream);
    this.ylabel.selectStream(ystream);

    this.hidden();

    this.series = new DataSeries(this.timeseries, xstream, ystream);
    this.series.color = this.color;
    this.lg.series = [this.series];

    xstream.gainChanged.subscribe(this.xGainChanged);
    this.xGainChanged(xstream.gain);
    ystream.gainChanged.subscribe(this.yGainChanged);
    this.yGainChanged(ystream.gain);

    this.series.updated.subscribe(this.updated);
    this._layoutChanged.subscribe(this.relayout);

    this.lg.needsRedraw(true);
  }

  hidden(): void {
    if (this.series) {
      this.series.updated.unListen(this.updated);
    }
    this._layoutChanged.unListen(this.relayout);

    if (this.xstream) this.xstream.gainChanged.unListen(this.xGainChanged);
    if (this.ystream) this.ystream.gainChanged.unListen(this.yGainChanged);
  }

  private updated = (): void => {
    this.lg.needsRedraw();
  };

  private xGainChanged = (g: number): void => {
    this.xaxis.window(this.xaxis.min / g, this.xaxis.max / g, true);
    this.lg.needsRedraw(true);
  };

  private yGainChanged = (g: number): void => {
    this.yaxis.window(this.yaxis.min / g, this.yaxis.max / g, true);
    this.lg.needsRedraw(true);
  };

  private relayout = (): void => {
    this.lg.resized();
  };
}

// --- OverlayGraph: scope-style multi-trace plot on shared divisions axis ---

export interface OverlayTrace {
  stream: Stream;
  series: DataSeries;
  color: [number, number, number];
  enabled: boolean;
  // Scope vertical controls. perDiv = stream units per screen division;
  // position = vertical offset in divisions (positive = up).
  perDiv: number;
  position: number;
}

// Number of vertical divisions above and below center (8 divisions total,
// like a typical scope graticule).
const OVERLAY_HALF_DIVS = 4;

export class OverlayGraph {
  lg: GraphCanvas;
  traces: OverlayTrace[] = [];
  private yaxis: Axis;
  readonly timeseries: TimeseriesGraphListener;
  private _layoutChanged: TypedEvent;
  private triggerOverlay: TriggerOverlay | null = null;

  constructor(
    public el: HTMLElement,
    timeseries: TimeseriesGraphListener,
    streams: Stream[],
    colors: [number, number, number][],
    layoutChanged: TypedEvent,
  ) {
    this.timeseries = timeseries;
    this._layoutChanged = layoutChanged;

    // Unitless "divisions" y-axis: the graticule is the shared reference and
    // each trace maps its own units onto it via perDiv/position.
    this.yaxis = new Axis(-OVERLAY_HALF_DIVS, OVERLAY_HALF_DIVS, 'div');

    this.lg = new GraphCanvas(el, timeseries.xaxis, this.yaxis, [], {
      xbottom: true, yright: false, xgrid: true, ygrid: true,
    });

    // X-axis pan/zoom: the overlay shares timeseries.xaxis, so it must drive
    // the same listener actions the stacked TimeseriesGraphs use — otherwise a
    // drag/zoom would move the axis without refetching data at the new window.
    // Targets include this overlay's canvas so it animates in lockstep.
    const xTargets = (): GraphCanvas[] => [this.lg, ...timeseries.graphs];
    this.lg.onResized = () => timeseries.queueWindowUpdate();
    this.lg.onClick = (pos): void => {
      // Left edge = trigger-level drag (mirrors the stacked graphs). The
      // level maps through the trigger trace's divisions transform.
      if (pos[0] < 45 && timeseries.trigger) {
        const trace = this.triggerTrace();
        if (trace) {
          new OverlayDragTriggerAction(this, trace, pos);
          return;
        }
      }
      if (timeseries.canChangeView()) {
        new DragScrollAction(this.lg, pos, xTargets());
      }
    };
    this.lg.onDblClick = (e, pos, btn): void => {
      if (!timeseries.canChangeView()) return;
      const zf = (e.shiftKey || btn === 2) ? 2 : 0.5;
      if (zf < 1 && timeseries.xaxis.span() < 40 * timeseries.device.sampleTime) return;
      new ZoomXAction({ time: 200, zoomFactor: zf }, this.lg, pos, xTargets());
    };

    // Build one trace per stream. Voltage traces start enabled (like a scope
    // powering on with its channels visible); currents are opt-in. A sensible
    // default perDiv puts the stream's full range across a few divisions.
    streams.forEach((stream, i) => {
      const series = new DataSeries(timeseries, 'time', stream);
      const color = colors[i] ?? [255, 0, 0];
      series.color = color;
      const fullRange = Math.max(Math.abs(stream.min), Math.abs(stream.max)) || 1;
      this.traces.push({
        stream,
        series,
        color,
        enabled: stream.units === 'V',
        perDiv: niceStep(fullRange / OVERLAY_HALF_DIVS),
        position: 0,
      });
    });

    timeseries.updated.subscribe(this.updated);
    this._layoutChanged.subscribe(this.relayout);
    this.applyTraces();
  }

  // Push the current enabled/perDiv/position state into the graph's series
  // list and per-series vertical transforms, then redraw.
  applyTraces(): void {
    const active = this.traces.filter(t => t.enabled);
    for (const t of active) {
      // screen_div = ydata / perDiv + position. Series renders
      // (ydata - yoffset) * yscale, so yscale = 1/perDiv and
      // yoffset = -position * perDiv.
      t.series.yscale = 1 / t.perDiv;
      t.series.yoffset = -t.position * t.perDiv;
      t.series.color = t.color;
    }
    this.lg.series = active.map(t => t.series);
    this.updateTrigger();
    this.lg.needsRedraw(true);
  }

  // The enabled trace whose stream the trigger listens on; falls back to the
  // first enabled trace (dragging will move the trigger to that stream, the
  // same way dragging a different stacked graph's edge switches it).
  triggerTrace(): OverlayTrace | undefined {
    const trig = this.timeseries.trigger;
    if (!trig) return undefined;
    return this.traces.find(t => t.enabled && t.stream === trig.stream)
      ?? this.traces.find(t => t.enabled);
  }

  // Show/position the trigger-level line, mapping the trigger's level (in
  // its stream's units) onto the divisions axis via that stream's trace.
  updateTrigger(): void {
    const trig = this.timeseries.trigger;
    const trace = trig
      ? this.traces.find(t => t.enabled && t.stream === trig.stream)
      : undefined;

    if (!trig || !trace) {
      this.triggerOverlay?.remove();
      this.triggerOverlay = null;
      return;
    }

    this.triggerOverlay ??= new TriggerOverlay(this.lg);
    this.triggerOverlay.position(trig.level / trace.perDiv + trace.position);
  }

  setEnabled(stream: Stream, enabled: boolean): void {
    const t = this.traces.find(tr => tr.stream === stream);
    if (t) { t.enabled = enabled; this.applyTraces(); }
  }

  setPerDiv(stream: Stream, perDiv: number): void {
    const t = this.traces.find(tr => tr.stream === stream);
    if (t && perDiv > 0) { t.perDiv = perDiv; this.applyTraces(); }
  }

  setPosition(stream: Stream, position: number): void {
    const t = this.traces.find(tr => tr.stream === stream);
    if (t) { t.position = position; this.applyTraces(); }
  }

  private updated = (): void => {
    this.lg.needsRedraw();
  };

  private relayout = (): void => {
    this.lg.resized();
  };

  hidden(): void {
    this.timeseries.updated.unListen(this.updated);
    this._layoutChanged.unListen(this.relayout);
    this.triggerOverlay?.remove();
    this.triggerOverlay = null;
  }
}

// Trigger-level drag on the overlay graph: pixels → divisions (graph axes)
// → stream units (through the trace's perDiv/position).
class OverlayDragTriggerAction extends Action {
  private transformData: ReturnType<typeof makeTransform>;
  private lastLevel: number;

  constructor(
    private og: OverlayGraph,
    private trace: OverlayTrace,
    pos: [number, number],
  ) {
    super(og.lg, pos);
    og.lg.startDrag(pos);
    this.transformData = makeTransform(og.lg.geom, og.lg.xaxis, og.lg.yaxis);
    this.lastLevel = og.timeseries.trigger ? og.timeseries.trigger.level : 0;
    this.onDrag(pos);
  }

  override onDrag(pos: [number, number]): void {
    const [, div] = invTransform(pos[0], pos[1], this.transformData);
    const s = this.trace.stream;
    const level = (div - this.trace.position) * this.trace.perDiv;
    this.lastLevel = Math.min(Math.max(level, s.min), s.max);
    this.og.timeseries.dragTrigger(s, this.lastLevel);
    this.og.updateTrigger();
  }

  override onRelease(): void {
    this.og.timeseries.setTrigger(this.trace.stream, this.lastLevel);
    this.og.updateTrigger();
  }
}

// Round a step up to a 1/2/5 ×10ⁿ "nice" value, for default per-division scaling.
function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}
