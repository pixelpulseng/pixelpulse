/**
 * Pixelpulse UI elements
 * Ported from views.coffee
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU GPLv3
 */

import {
  type CEEDevice, type Channel, type Stream, type OutputSource, type UpdateMessage,
  Listener, DataListener, server, backend,
} from './dataserver.js';
import { AXIS_SPACING, type GraphCanvas } from './livegraph.js';
import { unitPrefixScale } from './human-units.js';
import {
  TimeseriesGraphListener, TimeseriesGraph, XYGraphView, OverlayGraph,
  type StreamSelectElement,
} from './livegraph-data-listener.js';
import { numberWidget, selectDropdown, btnPopup, waveformIconBar, type NumberWidget, type WaveformIconBar } from './widgets.js';
import { downloadCSV, snapshotPNG } from './export.js';
import { TypedEvent } from './dataserver.js';
import { readVBUS } from './m1k-power.js';
import {
  bindShareState, scheduleCapture, parseRestorePlan, hasShareState, shareUrl,
  periodForFreq,
} from './share-state.js';

// --- Colors ---

const COLORS: [number, number, number][][] = [
  [[0x32, 0x00, 0xC7], [0x0, 0x32, 0xC7]],
  [[0x0, 0x7C, 0x16], [0x6f, 0xC7, 0x00]],
];

const GAIN_OPTIONS = [1, 2, 4, 8, 16, 32, 64];

// --- Pixelpulse state (module-level) ---

export const captureState = new TypedEvent<[boolean]>();
export const layoutChanged = new TypedEvent();
export const triggeringChanged = new TypedEvent<[boolean]>();

// Keep the overlay's trigger-level line in sync when triggering is toggled
// or reconfigured from the stacked view.
triggeringChanged.subscribe(() => overlayGraph?.updateTrigger());

// Keep the shareable URL in sync with layout/overlay/trigger changes. Reads
// are debounced (share-state.ts), so subscribing to noisy events is cheap.
layoutChanged.subscribe(() => scheduleCapture());
triggeringChanged.subscribe(() => scheduleCapture());

export let timeseries: TimeseriesGraphListener;
export let meterListener: Listener;
export let streams: Stream[] = [];
export let channelviews: ChannelView[] = [];
// timeseriesGraphs tracked via timeseries.graphs
let sidegraph1: XYGraphView;
let sidegraph2: XYGraphView;
let overlayGraph: OverlayGraph | null = null;
let overlayMode = false;
let currentLayout = 0; // # of side-graph panes shown (0/1/2)

// Channel outputs from a shared link are held here and applied Hi-Z-safe on
// the first Start, so opening a link never drives current during preview.
// "Pending" is three coupled pieces of UI state (the map, the body class, and
// the Start-button hint); setPendingOutputs is the single place that mutates
// all three, so they can never desync — and clearing on device reset/removal
// (destroyView) can't leak stale outputs onto the next device.
let pendingOutputs: Map<string, OutputSource> | null = null;
let defaultStartTitle = 'Start';

function setPendingOutputs(outputs: Map<string, OutputSource> | null): void {
  pendingOutputs = outputs && outputs.size > 0 ? outputs : null;
  const active = pendingOutputs !== null;
  document.body.classList.toggle('outputs-pending', active);
  const startBtn = document.getElementById('startpause');
  if (startBtn) {
    startBtn.title = active
      ? 'Start — applies the shared output settings (drives current)'
      : defaultStartTitle;
  }
}

// --- Shareable-state API (consumed by share-state.ts) ---

export interface ShareStateApi {
  getLayout(): number;
  getSideGraphs(): ({ x: number; y: number; isDefault: boolean } | null)[];
  getOverlayMode(): boolean;
  getOverlayTraces(): { index: number; perDiv: number; position: number; enabled: boolean }[];
  getPhosphor(): boolean;
  getTrigger(): { streamIndex: number; level: number } | null;
  getXWindow(): { min: number; max: number } | null;
}

const shareApi: ShareStateApi = {
  getLayout: () => currentLayout,
  getSideGraphs: () => {
    const one = (sg: XYGraphView | undefined, dx: number, dy: number) => {
      if (!sg?.xstream || !sg?.ystream) return null;
      const x = streams.indexOf(sg.xstream);
      const y = streams.indexOf(sg.ystream);
      if (x < 0 || y < 0) return null;
      return { x, y, isDefault: x === dx && y === dy };
    };
    return [one(sidegraph1, 0, 1), one(sidegraph2, 2, 3)];
  },
  getOverlayMode: () => overlayMode,
  getOverlayTraces: () => (overlayGraph?.traces ?? []).map(t => ({
    index: streams.indexOf(t.stream),
    perDiv: t.perDiv,
    position: t.position,
    enabled: t.enabled,
  })).filter(t => t.index >= 0),
  getPhosphor: () => !!timeseries?.graphs[0]?.phosphorEnabled,
  getTrigger: () => {
    const trig = timeseries?.trigger;
    if (!trig) return null;
    const streamIndex = streams.indexOf(trig.stream);
    if (streamIndex < 0) return null;
    return { streamIndex, level: trig.level };
  },
  getXWindow: () => {
    const ax = timeseries?.xaxis;
    if (!ax) return null;
    return { min: ax.visibleMin, max: ax.visibleMax };
  },
};

// --- Init view ---

export function initView(dev: CEEDevice): void {
  channelviews = [];
  streams = [];

  for (const channel of Object.values(dev.channels)) {
    for (const stream of Object.values(channel.streams)) {
      streams.push(stream);
    }
  }

  meterListener = new Listener(dev, streams);
  meterListener.configure();

  timeseries = new TimeseriesGraphListener(dev, streams);
  timeseries.onWindowChanged = () => scheduleCapture();
  timeseries.queueWindowUpdate();

  let i = 0;
  const streamsEl = document.getElementById('streams')!;
  for (const channel of Object.values(dev.channels)) {
    const cv = new ChannelView(channel, i++);
    channelviews.push(cv);
    streamsEl.appendChild(cv.el);
    // Reflect manual output edits (mode/setpoint/waveform) in the share URL.
    channel.outputChanged.subscribe(() => scheduleCapture());
  }

  sidegraph1 = new XYGraphView(
    document.getElementById('sidegraph1')!,
    timeseries, makeStreamSelect, layoutChanged,
  );
  sidegraph2 = new XYGraphView(
    document.getElementById('sidegraph2')!,
    timeseries, makeStreamSelect, layoutChanged,
  );

  // Scope-style overlay graph (all enabled streams on one divisions axis).
  // streams are enumerated channel-major (A.v, A.i, B.v, B.i), so the flat
  // color list mirrors COLORS[channel][stream].
  const overlayColors = COLORS.flat();
  overlayGraph = new OverlayGraph(
    document.getElementById('overlay-graph')!,
    timeseries, streams, overlayColors, layoutChanged,
  );
  buildOverlayControls();

  // Show x-axis ticks on the last visible stream
  relayoutXAxis();

  // Density rendering is the default: noise renders as an honest
  // confidence band instead of an averaged line
  setPhosphor(true);

  // M1K-only toolbar extras (input termination switches, VBUS power)
  const extrasBtn = document.getElementById('m1k-extras');
  if (extrasBtn) {
    extrasBtn.style.display = dev.model === 'com.analogdevices.m1k' ? '' : 'none';
  }

  meterListener.submit();

  // Apply a shared configuration from the URL, if present, then start keeping
  // the URL in sync with live changes.
  bindShareState(shareApi);
  restoreShareState(dev);
}

// Apply a shared-link configuration. View settings are applied immediately;
// channel outputs are stashed in `pendingOutputs` and applied on first Start
// (the app boots paused), so a shared link never drives current during
// preview. See share-state.ts.
function restoreShareState(dev: CEEDevice): void {
  if (!hasShareState()) return;
  const plan = parseRestorePlan();

  // Only reconfigure if the requested rate differs meaningfully. Devices with
  // a fixed clock (audio: sampleTime pinned to the AudioContext rate) report a
  // value the link can't change; a tolerant compare avoids a pointless
  // reconfigure/capture-reset from float rounding in the URL.
  if (plan.sampleTime != null
    && Math.abs(plan.sampleTime - dev.sampleTime) > 1e-4 * dev.sampleTime) {
    dev.configure({ sampleTime: plan.sampleTime });
  }

  if (plan.layout != null) setLayout(plan.layout);
  for (const sg of plan.sideGraphs) {
    const view = sg.slot === 1 ? sidegraph1 : sidegraph2;
    const xs = streams[sg.x];
    const ys = streams[sg.y];
    if (view && xs && ys) view.configure(xs, ys);
  }

  if (plan.phosphor === false) setPhosphor(false);

  if (plan.overlay) setOverlay(true);
  if (overlayGraph) {
    for (const t of plan.overlayTraces) {
      const s = streams[t.index];
      if (!s) continue;
      overlayGraph.setPerDiv(s, t.perDiv);
      overlayGraph.setPosition(s, t.position);
      overlayGraph.setEnabled(s, t.enabled);
    }
    buildOverlayControls();
  }

  if (plan.trigger) {
    const s = streams[plan.trigger.streamIndex];
    if (s) {
      if (!timeseries.isTriggerEnabled()) toggleTrigger();
      timeseries.setTrigger(s, plan.trigger.level);
      triggeringChanged.notify(true);
    }
  }

  // Restore the visible window last, after triggering (which resets the axis
  // scroll limits to ±1 s). Axis.window sets visibleMin/Max verbatim — it does
  // NOT clamp — so clamp here against the current bounds, or a wide shared
  // window (e.g. -3..0 with a trigger) would show a region outside the valid
  // buffer. A tighter triggered zoom (e.g. ±10 ms) still fits and is honored.
  if (plan.xWindow) {
    const ax = timeseries.xaxis;
    const lo = Math.max(plan.xWindow.min, ax.min);
    const hi = Math.min(plan.xWindow.max, ax.max);
    if (lo < hi) timeseries.goToWindow(lo, hi, false);
  }

  // Hold outputs until the user presses Start (see applyPendingOutputs).
  if (plan.channelOutputs.size > 0) setPendingOutputs(plan.channelOutputs);

  // Snapshot the applied state back into the hash (normalizes / drops
  // defaults) so the URL is canonical from the first load.
  scheduleCapture();
}

// Apply any deferred shared-link outputs to the device. Called once, when the
// user first starts capture — this is the moment current is allowed to flow.
// Returns true if it applied (or there was nothing pending); returns false and
// leaves the pending state intact if the device is gone, so a failed Start can
// be retried without losing the staged outputs.
function applyPendingOutputs(): boolean {
  if (!pendingOutputs) return true;
  const dev = server.device as CEEDevice | null;
  if (!dev) return false;
  for (const ch of Object.values(dev.channels) as Channel[]) {
    const src = pendingOutputs.get(ch.id);
    if (!src) continue;
    const out = { ...src };
    // Shared periodic sources carry frequency (Hz); convert to the device's
    // period-in-samples against its live sampleTime, then drop the marker.
    if (typeof out.freqHz === 'number') {
      out.period = periodForFreq(out.freqHz, dev.sampleTime);
      delete out.freqHz;
    }
    ch.setDirect(out);
  }
  setPendingOutputs(null);
  return true;
}

// The time-axis labels are drawn by exactly one graph (showXbottom).
// Rows can be hidden (M1K Hi-Z hides the current stream), so the labels
// must follow the last *visible* graph.
function relayoutXAxis(): void {
  let lastVisible: TimeseriesGraph | null = null;
  for (const lg of timeseries.graphs) {
    const section = lg.div.closest('section.stream') as HTMLElement | null;
    if (section && section.style.display !== 'none') {
      lastVisible = lg;
    }
  }

  for (const lg of timeseries.graphs) {
    const isLast = lg === lastVisible;
    if (lg.showXbottom === isLast) continue;
    lg.showXbottom = isLast;

    const margin = isLast ? `${-AXIS_SPACING + 5}px` : '';
    lg.div.style.marginBottom = margin;
    const aside = lg.div.parentElement?.querySelector('aside') as HTMLElement | null;
    if (aside) aside.style.marginBottom = margin;

    lg.resized();
    lg.needsRedraw(true);
  }
}

export function toggleTrigger(): void {
  const triggering = !timeseries.isTriggerEnabled();
  document.body.classList.toggle('triggering', triggering);

  timeseries.cancelAllActions();

  if (triggering) {
    timeseries.enableTrigger();
  } else {
    timeseries.disableTrigger();
  }

  timeseries.updateWindow();
  updatePhosphorAccumulate();
  triggeringChanged.notify(triggering);
}

export function autozoom(): void {
  timeseries.autozoom();
}

export function togglePhosphor(): void {
  setPhosphor(!timeseries.graphs[0]?.phosphorEnabled);
}

// Scope-style "divisions" choices for the per-trace units/div selector.
// Extends to 200 so current streams (±200 mA full scale, default 50 mA/div)
// have their working range available.
const PER_DIV_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200,
];

// Build the overlay controls panel: one row per stream with an include
// checkbox, a units/div selector, and a vertical-position slider, each row
// color-keyed to its trace.
function buildOverlayControls(): void {
  const panel = document.getElementById('overlay-controls');
  if (!panel || !overlayGraph) return;
  panel.innerHTML = '';

  for (const t of overlayGraph.traces) {
    const row = document.createElement('div');
    row.className = 'overlay-row';
    row.style.setProperty('--trace-color', `rgb(${t.color[0]},${t.color[1]},${t.color[2]})`);

    const name = `${t.stream.parent.displayName} ${t.stream.displayName}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.enabled;
    cb.addEventListener('change', () => {
      overlayGraph!.setEnabled(t.stream, cb.checked);
      scheduleCapture();
    });

    const label = document.createElement('label');
    label.className = 'overlay-name';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${name}`));

    const perDiv = document.createElement('select');
    perDiv.className = 'overlay-perdiv';
    perDiv.title = `${t.stream.units} per division`;
    // Include the trace's active perDiv even if it's not a standard step, so
    // the dropdown always displays the true setting.
    const steps = PER_DIV_STEPS.includes(t.perDiv)
      ? PER_DIV_STEPS
      : [...PER_DIV_STEPS, t.perDiv].sort((a, b) => a - b);
    for (const step of steps) {
      const opt = document.createElement('option');
      opt.value = String(step);
      opt.textContent = `${step} ${t.stream.units}/div`;
      if (step === t.perDiv) opt.selected = true;
      perDiv.appendChild(opt);
    }
    perDiv.addEventListener('change', () => {
      overlayGraph!.setPerDiv(t.stream, parseFloat(perDiv.value));
      scheduleCapture();
    });

    const pos = document.createElement('input');
    pos.type = 'range';
    pos.className = 'overlay-pos';
    pos.min = '-4'; pos.max = '4'; pos.step = '0.1';
    pos.value = String(t.position);
    pos.title = 'Vertical position (divisions)';

    const posVal = document.createElement('output');
    posVal.className = 'overlay-pos-val';
    const fmtPos = (p: number): string => `${p >= 0 ? '+' : ''}${p.toFixed(1)} div`;
    posVal.textContent = fmtPos(t.position);

    pos.addEventListener('input', () => {
      const p = parseFloat(pos.value);
      posVal.textContent = fmtPos(p);
      overlayGraph!.setPosition(t.stream, p);
      scheduleCapture();
    });

    const posRow = document.createElement('div');
    posRow.className = 'overlay-pos-row';
    posRow.appendChild(pos);
    posRow.appendChild(posVal);

    row.appendChild(label);
    row.appendChild(perDiv);
    row.appendChild(posRow);
    panel.appendChild(row);
  }
}

export function setOverlay(enabling: boolean): void {
  if (enabling && !overlayGraph) return; // no device/view yet
  overlayMode = enabling;
  document.body.classList.toggle('overlay-mode', overlayMode);
  // The body-class CSS (body.overlay-mode #overlaybtn) drives the active
  // highlight, matching the Phosphor button.
  // Whichever view just became visible was display:none and so has a stale,
  // zero-size canvas; notify layout to resize and redraw both directions.
  layoutChanged.notify();
  if (overlayMode) {
    overlayGraph?.lg.needsRedraw(true);
    // Trigger may have been (re)configured while the overlay was hidden
    overlayGraph?.updateTrigger();
  }
}

export function toggleOverlay(): void {
  setOverlay(!overlayMode);
}

export function setPhosphor(enabling: boolean): void {
  const btn = document.getElementById('phosphorbtn');
  const accumulate = timeseries.isTriggerEnabled();

  for (const lg of timeseries.graphs) {
    if (enabling) {
      const series = lg.series[0];
      lg.enablePhosphor(series?.color ?? [0x32, 0x00, 0xC7]);
      lg.phosphorAccumulate = accumulate;
    } else {
      lg.disablePhosphor();
    }
  }

  // Request undecimated data for phosphor density
  timeseries.phosphorRaw = enabling;
  timeseries.updateWindow();

  btn?.classList.toggle('active', enabling);
  document.body.classList.toggle('phosphor-mode', enabling);
  scheduleCapture();
}

function updatePhosphorAccumulate(): void {
  const accumulate = timeseries.isTriggerEnabled();
  for (const lg of timeseries.graphs) {
    if (lg.phosphorEnabled) {
      lg.phosphorAccumulate = accumulate;
      lg.phosphor?.clear();
      lg.phosphorNeedsFull = true;
    }
  }
}

captureState.subscribe(() => {
  if (!timeseries?.canChangeView()) {
    timeseries.zoomCompletelyOut(false);
  }
});

export function destroyView(): void {
  document.querySelectorAll('#streams section.channel').forEach(el => el.remove());
  document.querySelectorAll('#sidegraphs > section').forEach(el => { el.innerHTML = ''; });
  overlayGraph?.hidden();
  overlayGraph = null;
  overlayMode = false;
  document.body.classList.remove('overlay-mode');
  document.getElementById('overlaybtn')?.classList.remove('active');
  const overlayGraphEl = document.getElementById('overlay-graph');
  if (overlayGraphEl) overlayGraphEl.innerHTML = '';
  const overlayControlsEl = document.getElementById('overlay-controls');
  if (overlayControlsEl) overlayControlsEl.innerHTML = '';
  meterListener?.cancel();
  timeseries?.cancel();
  for (const cv of channelviews) cv.destroy();
  // Drop any staged shared-link outputs so they can't leak onto the next
  // device (a swap/removal must not carry another device's drive settings).
  setPendingOutputs(null);
  setLayout(0);
}

// --- ChannelView ---

class ChannelView {
  el: HTMLElement;
  private section: HTMLElement;
  private streamViews: StreamView[] = [];
  private resistanceEl: HTMLDivElement;
  private modeSel: ReturnType<typeof selectDropdown> | null = null;

  constructor(public channel: Channel, public index: number) {
    this.section = document.createElement('section');
    this.section.className = 'channel';
    this.el = this.section;

    const header = document.createElement('header');
    this.section.appendChild(header);

    const aside = document.createElement('aside');
    header.appendChild(aside);

    const h1 = document.createElement('h1');
    h1.textContent = channel.displayName;
    aside.appendChild(h1);

    this.resistanceEl = document.createElement('div');
    this.resistanceEl.className = 'resistance';
    aside.appendChild(this.resistanceEl);

    let i = 0;
    for (const s of Object.values(channel.streams)) {
      const sv = new StreamView(this, s, i++);
      this.streamViews.push(sv);
      this.section.appendChild(sv.el);
    }

    // M1K: one mode per channel (Hi-Z / source V / source I), selected in
    // the channel header; the per-stream Source/Measure dropdowns are
    // hidden. In Hi-Z the current row disappears entirely (the firmware
    // disconnects the output amplifier — definitionally no current flows),
    // so mode selection must live here to stay reachable.
    if ((server.device as CEEDevice).model === 'com.analogdevices.m1k') {
      this.modeSel = selectDropdown({
        options: ['Hi-Z', 'Source V', 'Source I'],
        showText: true,
        changed: (o) => {
          const m = o === 'Source V' ? 1 : o === 'Source I' ? 2 : 0;
          this.channel.setConstant(m, 0);
        },
      });
      this.modeSel.el.classList.add('channel-mode');
      aside.appendChild(this.modeSel.el);

      this.channel.outputChanged.subscribe(this.onModeChanged);
      if (this.channel.source) {
        this.onModeChanged(this.channel.source);
      }
    }

    meterListener.updated.subscribe(this.onValues);
  }

  private onModeChanged = (m: OutputSource): void => {
    const mode = Number(m.mode) || 0;
    this.modeSel?.select(mode === 1 ? 'Source V' : mode === 2 ? 'Source I' : 'Hi-Z');

    const iView = this.streamViews.find(sv => sv.stream.id === 'i');
    if (iView) {
      const hide = mode === 0;
      if ((iView.el.style.display === 'none') !== hide) {
        iView.el.style.display = hide ? 'none' : '';
        relayoutXAxis(); // time labels follow the last visible graph
        layoutChanged.notify(); // graphs re-measure on next redraw
      }
    }
  };

  destroy(): void {
    for (const sv of this.streamViews) sv.destroy();
  }

  private onValues = (m: UpdateMessage): void => {
    const source = this.channel.source;

    let sourceStream: Stream | undefined;
    let measureStream: Stream | undefined;

    for (const s of Object.values(this.channel.streams)) {
      // eslint-disable-next-line eqeqeq -- server may send mode as number or string
      if (s.outputMode == source.mode) {
        sourceStream = s;
      } else {
        measureStream = s;
      }
    }

    // Disabled / HI_Z: no source stream matches mode 0
    if (!sourceStream || !measureStream) {
      this.hideResistance();
      return;
    }

    if (source.source !== 'constant') {
      this.updateImpedance();
      return;
    }

    const srcArr = m.data[meterListener.streamIndex(sourceStream)];
    const sourceValue = srcArr[srcArr.length - 1];

    const measArr = m.data[meterListener.streamIndex(measureStream)];
    const measureValue = measArr[measArr.length - 1];

    // uncertainty alone is too tight a tolerance on the M1K (1 LSB of a
    // 16-bit converter), so also allow a fraction of the stream's full range
    const sourceTol = Math.max(sourceStream.uncertainty * 5, (sourceStream.max - sourceStream.min) * 0.005);
    const railTol = Math.max(measureStream.uncertainty * 5, (measureStream.max - measureStream.min) * 0.01);

    const sourceChannelIsOff = Math.abs(sourceValue - (source.value ?? 0)) > sourceTol;
    const measureChannelIsHiRail = Math.abs(measureValue - measureStream.max) < railTol;
    const measureChannelIsLoRail = Math.abs(measureValue - measureStream.min) < railTol;

    const isLimited = sourceChannelIsOff && (measureChannelIsHiRail || measureChannelIsLoRail);
    this.section.classList.toggle('limited', isLimited);

    // Resistance display: R = V / I
    const minMeasure = Math.max(measureStream.uncertainty * 2, (measureStream.max - measureStream.min) * 1e-5);
    if (!isLimited && Math.abs(measureValue) > minMeasure) {
      let voltage: number, current: number;
      if (sourceStream.id === 'v') {
        voltage = sourceValue;
        current = measureValue;
      } else {
        voltage = measureValue;
        current = sourceValue;
      }
      const r = Math.abs(voltage / current);
      // current is in mA, voltage in V -> R = V / (mA/1000) = V*1000/mA
      const rOhms = r * 1000;
      this.resistanceEl.textContent = formatResistance(rOhms);
      this.resistanceEl.style.display = '';
    } else {
      this.resistanceEl.style.display = 'none';
    }
  };

  private hideResistance(): void {
    this.section.classList.remove('limited');
    this.resistanceEl.style.display = 'none';
  }

  // Waveform source: |Z| = ac RMS voltage / ac RMS current over the visible window
  private updateImpedance(): void {
    this.section.classList.remove('limited');

    const vView = this.streamViews.find(sv => sv.stream.id === 'v');
    const iView = this.streamViews.find(sv => sv.stream.id === 'i');
    const vStats = vView?.windowStats();
    const iStats = iView?.windowStats();

    const iStream = iView?.stream;
    const minCurrent = iStream
      ? Math.max(iStream.uncertainty * 2, (iStream.max - iStream.min) * 1e-5)
      : Infinity;

    if (vStats && iStats && iStats.acrms > minCurrent) {
      // current in mA, voltage in V -> ohms = V/mA * 1000
      this.resistanceEl.textContent = formatResistance(vStats.acrms / iStats.acrms * 1000);
      this.resistanceEl.style.display = '';
    } else {
      this.resistanceEl.style.display = 'none';
    }
  }
}

// --- StreamView ---

class StreamView {
  el: HTMLElement;
  lg: TimeseriesGraph;

  private valueEl: HTMLSpanElement;
  private unitSpan: HTMLSpanElement;
  private statsEl: HTMLDivElement;
  private sourceHead: HTMLHeadingElement;
  private sourceEl: HTMLDivElement;
  private sourceModeSel: ReturnType<typeof selectDropdown>;
  private sourceTypeSel: WaveformIconBar;
  private gainOpts: HTMLSelectElement | null = null;
  private sourceInputs: NumberWidget[] = [];
  private sourceType: string | null = null;
  private lastSourceMode: string | number | null = null;
  private lastValue = 0;
  private valueUnitScale = 1;
  private valueDigits = 0;
  private isSource = false;

  constructor(
    public channelView: ChannelView,
    public stream: Stream,
    public index: number,
  ) {
    const section = document.createElement('section');
    section.className = 'stream';
    this.el = section;

    const aside = document.createElement('aside');
    section.appendChild(aside);

    const h1 = document.createElement('h1');
    h1.textContent = stream.displayName;
    aside.appendChild(h1);

    const timeseriesDiv = document.createElement('div');
    timeseriesDiv.className = 'livegraph';
    section.appendChild(timeseriesDiv);

    // Reading UI
    const reading = document.createElement('span');
    reading.className = 'reading';
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'value';
    this.unitSpan = document.createElement('span');
    this.unitSpan.className = 'unit';
    reading.appendChild(this.valueEl);
    reading.appendChild(this.unitSpan);
    aside.appendChild(reading);

    // Stats readout (RMS, avg, min, max) for measured signals
    this.statsEl = document.createElement('div');
    this.statsEl.className = 'stats';
    aside.appendChild(this.statsEl);

    const color = COLORS[channelView.index][index];
    this.lg = timeseries.makeGraph(stream, timeseriesDiv, color);

    // Meter listener
    meterListener.updated.subscribe((m: UpdateMessage) => {
      const idx = meterListener.streamIndex(stream);
      const arr = m.data[idx];
      this.onValue(arr[arr.length - 1]);
      if (!this.isSource) {
        this.updateStats();
      }
    });

    // Source controls
    this.sourceHead = document.createElement('h2');
    aside.appendChild(this.sourceHead);

    const modeOpts = ['Source', 'Measure'];
    if (stream.id === 'i') modeOpts.push('Disable');

    this.sourceModeSel = selectDropdown({
      options: modeOpts,
      showText: true,
      changed: (o) => {
        let m: string | number;
        switch (o) {
          case 'Disable': m = 0; break;
          case 'Source': m = stream.outputMode; break;
          case 'Measure':
            m = stream.id === 'v' ? 2 : stream.id === 'i' ? 1 : 0;
            break;
          default: m = 0;
        }
        stream.parent.setConstant(m, 0);
      },
    });
    this.sourceHead.appendChild(this.sourceModeSel.el);

    // M1K: mode is selected at the channel level instead
    if ((server.device as CEEDevice).model === 'com.analogdevices.m1k') {
      this.sourceModeSel.el.style.display = 'none';
    }

    this.sourceTypeSel = waveformIconBar(
      ['Constant', 'Sine', 'Triangle', 'Square'],
      (o) => {
        let src = o.toLowerCase();
        if (src === 'square' && (server.device as CEEDevice).hasAdvSquare) {
          src = 'adv_square';
        }
        stream.parent.guessSourceOptions(src);
      },
    );
    this.sourceHead.appendChild(this.sourceTypeSel.el);

    this.sourceEl = document.createElement('div');
    this.sourceEl.className = 'source';
    aside.appendChild(this.sourceEl);

    stream.parent.outputChanged.subscribe(this.sourceChanged);
    if (stream.parent.source) {
      this.sourceChanged(stream.parent.source);
    }

    // Gain selector
    if (stream.id === 'v' && (server.device as CEEDevice).hasGain) {
      this.gainOpts = document.createElement('select');
      this.gainOpts.className = 'gainopts';
      aside.appendChild(this.gainOpts);
      this.gainOpts.addEventListener('change', () => {
        stream.setGain(parseInt(this.gainOpts!.value));
      });

      for (const g of GAIN_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = String(g);
        opt.innerHTML = `${g}&times;`;
        this.gainOpts.appendChild(opt);
      }
    }

    stream.gainChanged.subscribe(this.gainChanged);
    this.gainChanged(stream.gain);
  }

  private onValue(val: number): void {
    const v = val / this.valueUnitScale;

    if (!isNaN(v)) {
      this.valueEl.textContent = v.toFixed(this.valueDigits);
    } else {
      this.valueEl.textContent = '- - - ';
    }

    this.valueEl.classList.toggle('negative', v < 0);
    this.lastValue = val;
  }

  // Stats over the graph's buffered samples in the visible time window.
  // The meter listener only delivers one heavily-averaged sample per update,
  // so min/max/RMS must come from the timeseries buffer instead.
  windowStats(): { n: number; avg: number; rms: number; acrms: number; min: number; max: number } | null {
    const xdata = this.lg.dseries.xdata;
    const ydata = this.lg.dseries.ydata;
    const [j0, j1] = timeseries.validRange();
    const xmin = timeseries.xaxis.visibleMin;
    const xmax = timeseries.xaxis.visibleMax;

    let sum = 0, sumSq = 0, mn = Infinity, mx = -Infinity, n = 0;
    const end = Math.min(j1, xdata.length, ydata.length);
    for (let j = Math.max(0, j0); j < end; j++) {
      const x = xdata[j];
      if (x < xmin || x > xmax) continue;
      const v = ydata[j];
      if (isNaN(v)) continue;
      sum += v;
      sumSq += v * v;
      n++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    if (n === 0) return null;
    const avg = sum / n;
    const meanSq = sumSq / n;
    return {
      n, avg, min: mn, max: mx,
      rms: Math.sqrt(meanSq),
      acrms: Math.sqrt(Math.max(0, meanSq - avg * avg)),
    };
  }

  private updateStats(): void {
    const stats = this.windowStats();
    if (!stats) {
      this.statsEl.textContent = '';
      return;
    }

    const scale = this.valueUnitScale;
    const d = Math.max(0, this.valueDigits);

    this.statsEl.innerHTML =
      `<span title="RMS">⌀${(stats.rms / scale).toFixed(d)}</span>` +
      `<span title="Average">μ${(stats.avg / scale).toFixed(d)}</span>` +
      `<span title="Min">↓${(stats.min / scale).toFixed(d)}</span>` +
      `<span title="Max">↑${(stats.max / scale).toFixed(d)}</span>`;
  }

  private sourceChanged = (m: OutputSource): void => {
    // eslint-disable-next-line eqeqeq -- server may send mode as number or string
    const isSource = m.mode == this.stream.outputMode;

    if (m.mode !== this.lastSourceMode) {
      this.lastSourceMode = m.mode;
      this.sourceHead.classList.toggle('isDriving', isSource);

      let opt: string;
      // eslint-disable-next-line eqeqeq
      if (this.stream.id === 'i' && m.mode == 0) {
        opt = 'Disable';
      } else {
        opt = isSource ? 'Source' : 'Measure';
      }
      this.sourceModeSel.select(opt);

      // Hide source type icons if not source
      this.sourceTypeSel.el.style.display = isSource ? '' : 'none';
    }

    this.isSource = isSource;
    this.statsEl.style.display = isSource ? 'none' : '';

    this.lg.sourceChanged(isSource, m);

    if (isSource) {
      if (m.source !== this.sourceType) {
        this.sourceType = m.source;
        this.sourceTypeSel.select(
          this.sourceType === 'adv_square' ? 'Square' : capitalize(this.sourceType),
        );

        this.sourceInputs = [];
        this.sourceEl.innerHTML = '';

        const stream = this.stream;
        const channel = stream.parent;
        const dev = server.device as CEEDevice;

        const propInput = (filter: ReturnType<typeof valFilter>, title: string, cssClass: string): NumberWidget => {
          const w = numberWidget(filter, title, cssClass);
          this.sourceInputs.push(w);
          this.sourceEl.appendChild(w.el);
          return w;
        };

        const valFilter = (prop: string) => ({
          changedfn: (v: number) => channel.setAdjust(prop, v),
          valuefn: (m: unknown) => (m as Record<string, number>)[prop],
          min: stream.min,
          max: stream.max,
          step: Math.pow(10, -stream.digits),
          unit: stream.units,
          digits: stream.digits,
        });

        const freqFilter = {
          changedfn: (v: number) => {
            channel.setAdjust('period', 1 / (v * dev.sampleTime));
          },
          valuefn: (m: unknown) => 1 / ((m as Record<string, number>).period * dev.sampleTime),
          min: 0.1,
          max: 1 / dev.sampleTime / 5,
          step: 1,
          unit: 'Hz',
          digits: 1,
        };

        const freqFilterSquare = {
          ...freqFilter,
          changedfn: (v: number) => {
            const period = 1 / (v * dev.sampleTime);
            const { dutyCycleHint = 0.5 } = stream.parent.source;
            const t1 = period * dutyCycleHint;
            channel.setAdjust({
              highSamples: Math.round(t1),
              lowSamples: Math.round(period - t1),
              dutyCycleHint,
            });
          },
          valuefn: (m: unknown) => {
            const rec = m as Record<string, number>;
            return 1 / ((rec.highSamples + rec.lowSamples) * dev.sampleTime);
          },
        };

        const dutyCycleFilter = {
          changedfn: (v: number) => {
            v = Math.max(0, Math.min(100, v / 100));
            const { highSamples = 0, lowSamples = 0 } = stream.parent.source;
            const per = highSamples + lowSamples;
            channel.setAdjust({
              highSamples: Math.ceil(v * per),
              lowSamples: Math.floor((1 - v) * per),
              dutyCycleHint: v,
            });
          },
          valuefn: (m: unknown) => {
            const rec = m as Record<string, number>;
            return rec.highSamples / (rec.highSamples + rec.lowSamples) * 100;
          },
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          digits: 1,
        };

        switch (m.source) {
          case 'constant':
            propInput(valFilter('value'), 'Value', 'inp-value');
            break;
          case 'adv_square':
            propInput(valFilter('low'), 'Value 1', 'inp-value1');
            propInput(valFilter('high'), 'Value 2', 'inp-value2');
            propInput(freqFilterSquare, 'Frequency', 'inp-freq');
            propInput(dutyCycleFilter, 'Duty Cycle', 'inp-duty');
            break;
          case 'sine': case 'triangle': case 'square':
            propInput(valFilter('offset'), 'Center Value', 'inp-value');
            propInput(valFilter('amplitude'), 'Amplitude', 'inp-amplitude');
            propInput(freqFilter, 'Frequency', 'inp-frequency');
            break;
        }
      }

      for (const inp of this.sourceInputs) {
        inp.set(m);
      }
    } else {
      this.sourceEl.innerHTML = '';
      this.sourceType = null;
    }
  };

  private gainChanged = (g: number): void => {
    if (this.gainOpts) this.gainOpts.value = String(g);
    this.lg.gainChanged(g);

    const prescale = this.lg.yaxis.prescale ?? 1;
    const [unitPrefix, unitScale] = unitPrefixScale(this.lg.yaxis.span() / 2 / prescale);
    this.unitSpan.textContent = unitPrefix + this.lg.yaxis.unit;
    this.valueUnitScale = unitScale * prescale;
    this.valueDigits = this.stream.digits + Math.floor(Math.log(this.valueUnitScale) / Math.LN10);
    this.onValue(this.lastValue);
  };

  destroy(): void {
    // Cleanup if needed
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatResistance(ohms: number): string {
  if (ohms >= 1e6) return (ohms / 1e6).toFixed(2) + ' MΩ';
  if (ohms >= 1e3) return (ohms / 1e3).toFixed(2) + ' kΩ';
  return ohms.toFixed(1) + ' Ω';
}

// --- Layout ---

export function setLayout(l: number): void {
  currentLayout = l;
  document.body.classList.remove('layout-0side', 'layout-1side', 'layout-2side');
  document.body.classList.add(`layout-${l}side`);

  if (sidegraph1 && sidegraph2) {
    // Devices expose 2–4 streams (the audio backend has only Out + In);
    // a side graph without a stream pair for its default axes stays hidden.
    if (l >= 1 && streams[1]) {
      sidegraph1.configure(streams[0], streams[1]);
    } else {
      sidegraph1.hidden();
    }

    if (l >= 2 && streams[3]) {
      sidegraph2.configure(streams[2], streams[3]);
    } else {
      sidegraph2.hidden();
    }
  }

  layoutChanged.notify();
}

layoutChanged.subscribe(() => {
  timeseries?.redrawAll();
});

// --- Stream select factory ---

export function makeStreamSelect(): StreamSelectElement {
  const sel = document.createElement('select') as StreamSelectElement;
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${s.displayName} (${s.units})`;
    sel.appendChild(opt);
  }

  sel.selectStream = (stream: Stream) => {
    sel.value = String(streams.indexOf(stream));
  };

  sel.stream = () => streams[parseInt(sel.value)];

  return sel;
}

// --- Snapshot targets ---

interface SnapshotTarget {
  graph: GraphCanvas;
  title: string;
  filename: string;
}

// Everything currently on screen that can be saved as a PNG: the time-series
// channel graphs, plus any side-graph XY/V-I plots visible in the current
// layout. Rebuilt on each export so it reflects the live layout and streams.
function snapshotTargets(): SnapshotTarget[] {
  // Both channels' streams share displayName ("Voltage"/"Current"), so the
  // channel name is required to disambiguate picker entries and filenames.
  const targets: SnapshotTarget[] = timeseries.graphs.map(g => ({
    graph: g,
    title: `${g.stream.parent.displayName} ${g.stream.displayName} (${g.stream.units})`,
    filename: `${g.stream.parent.displayName}-${g.stream.displayName}`,
  }));

  const sidegraphs = [sidegraph1, sidegraph2];
  for (let i = 0; i < currentLayout && i < sidegraphs.length; i++) {
    const sg = sidegraphs[i];
    if (!sg?.xstream || !sg.ystream) continue;
    const title = `${sg.ystream.displayName} vs ${sg.xstream.displayName}`;
    targets.push({
      graph: sg.lg,
      title,
      filename: `${sg.ystream.displayName}-vs-${sg.xstream.displayName}`,
    });
  }

  if (overlayMode && overlayGraph) {
    targets.unshift({
      graph: overlayGraph.lg,
      title: 'Overlay',
      filename: 'overlay',
    });
  }
  return targets;
}

// --- Document ready setup ---

export function setupToolbar(): void {
  // Remember the Start button's resting tooltip so the pending-outputs hint
  // can be reverted cleanly.
  defaultStartTitle = document.getElementById('startpause')?.getAttribute('title') ?? 'Start';

  // Backend chooser: the backend binds at module load, so switching is
  // "rewrite the hash, reload". Unrelated hash flags (perfstat, ...) are
  // preserved; backend tokens (connect/sim/audio and sim params) replaced.
  const backendSel = document.getElementById('backend-select') as HTMLSelectElement | null;
  if (backendSel) {
    backendSel.value = backend.kind === 'websocket' ? 'connect' : backend.kind;
    backendSel.addEventListener('change', () => {
      const keep = location.hash.slice(1).split('&').filter(f =>
        f && !/^(connect(=.*)?|sim|audio|bat=.*)$/.test(f));
      if (backendSel.value !== 'webusb') keep.unshift(backendSel.value);
      location.hash = keep.join('&');
      location.reload();
    });
  }

  // Share button: copy a link reproducing the current configuration.
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    const defaultTitle = shareBtn.getAttribute('title') ?? 'Share';
    shareBtn.addEventListener('click', async () => {
      const url = shareUrl();
      let ok = true;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        ok = false;
      }
      shareBtn.classList.add('copied');
      shareBtn.textContent = ok ? 'Copied!' : 'Copy failed';
      if (!ok) shareBtn.title = url; // let the user copy it manually
      setTimeout(() => {
        shareBtn.classList.remove('copied');
        shareBtn.textContent = 'Share';
        shareBtn.title = defaultTitle;
      }, 1500);
    });
  }

  // Config popup
  const configBtn = document.getElementById('device-config');
  const configPopup = document.getElementById('config-popup');
  let hideConfig: (() => void) | null = null;
  if (configBtn && configPopup) {
    hideConfig = btnPopup(configBtn, configPopup, () => {
      const dev = server.device as CEEDevice;
      const rateSelect = document.getElementById('config-sample-rate') as HTMLSelectElement;
      for (const opt of Array.from(rateSelect.options)) {
        opt.style.display = parseFloat(opt.value) >= dev.minSampleTime ? '' : 'none';
      }
      rateSelect.value = String(dev.sampleTime);
    });
  }

  // M1K extras popup: 50R input termination + VBUS power readout
  const extrasBtn = document.getElementById('m1k-extras');
  const extrasPopup = document.getElementById('m1k-extras-popup');
  if (extrasBtn && extrasPopup) {
    const termButtons = Array.from(
      extrasPopup.querySelectorAll<HTMLButtonElement>('button[data-term]'),
    );

    const setTermUI = (ch: string, term: string): void => {
      for (const b of termButtons) {
        if (b.dataset.ch === ch) {
          b.classList.toggle('active', b.dataset.term === term);
        }
      }
    };

    for (const b of termButtons) {
      b.addEventListener('click', () => {
        const ch = b.dataset.ch!;
        const term = b.dataset.term!;
        server.send('setFrontend', {
          channel: ch,
          r50_2v5: term === '2v5',
          r50_gnd: term === 'gnd',
          id: server.createCallback(() => setTermUI(ch, term)),
        });
      });
    }

    const vbusEl = document.getElementById('vbus-reading')!;
    let vbusTimer: ReturnType<typeof setInterval> | null = null;
    const pollVBUS = async (): Promise<void> => {
      const r = await readVBUS(server.device as CEEDevice);
      vbusEl.textContent = r
        ? `${r.voltage.toFixed(3)} V · ${r.currentMA.toFixed(1)} mA`
        : 'read error';
    };

    btnPopup(extrasBtn, extrasPopup, () => {
      server.send('getFrontend', {
        id: server.createCallback((d) => {
          const fe = (d as Record<string, unknown>).frontend as
            Record<string, Record<string, unknown>> | undefined;
          for (const ch of ['a', 'b']) {
            const c = fe?.[ch];
            if (!c) continue;
            setTermUI(ch, c.r50_2v5 ? '2v5' : c.r50_gnd ? 'gnd' : 'off');
          }
        }),
      });
      vbusEl.textContent = '…';
      void pollVBUS();
      vbusTimer = setInterval(pollVBUS, 2000);
    }, () => {
      if (vbusTimer !== null) {
        clearInterval(vbusTimer);
        vbusTimer = null;
      }
    });
  }

  // Apply config
  document.getElementById('device-config-apply')?.addEventListener('click', () => {
    hideConfig?.();
    const rate = parseFloat(
      (document.getElementById('config-sample-rate') as HTMLSelectElement).value,
    );
    (server.device as CEEDevice).configure({ sampleTime: rate });
    scheduleCapture();
  });

  // Export popup: CSV download or PNG snapshot of a chosen graph
  const exportCSV = (): void => {
    const dev = server.device as CEEDevice;
    const wasCapturing = !!dev.captureState;
    dev.pauseCapture();
    const len = timeseries.doneSamples;
    const maxCount = 40000;

    const allStreams: Stream[] = [];
    for (const channel of Object.values(dev.channels)) {
      for (const stream of Object.values(channel.streams)) {
        allStreams.push(stream);
      }
    }

    const df = Math.max(Math.round(len / maxCount), 1);
    const listener = new DataListener(dev, allStreams);
    listener.configure(0, len * dev.sampleTime, Math.floor(len / df));
    listener.submit();

    listener.done.subscribe(() => {
      const cols = allStreams.map((stream, i) => ({
        name: stream.displayName,
        units: stream.units,
        precision: 4,
        data: Array.from(listener.data[i]),
      }));

      cols.unshift({
        name: 'Time',
        units: 's',
        precision: 7,
        data: Array.from(listener.xdata).map((_, i) => i * dev.sampleTime * df),
      });

      downloadCSV(cols);
      // Capture was only paused to snapshot a consistent buffer; hand the
      // device back in the state the user left it.
      if (wasCapturing) dev.startCapture();
    });
  };

  const exportBtn = document.getElementById('download-btn');
  const exportPopup = document.getElementById('export-popup');
  const pngGraphSel = document.getElementById('export-png-graph') as HTMLSelectElement | null;
  let hideExport: (() => void) | null = null;
  if (exportBtn && exportPopup && pngGraphSel) {
    hideExport = btnPopup(exportBtn, exportPopup, () => {
      // Populate the PNG picker with everything currently on screen: the
      // time-series channel graphs plus any visible side-graph XY/V-I plots.
      pngGraphSel.innerHTML = '';
      snapshotTargets().forEach((t, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = t.title;
        pngGraphSel.appendChild(opt);
      });
    });
  }

  document.getElementById('export-csv')?.addEventListener('click', () => {
    hideExport?.();
    exportCSV();
  });

  document.getElementById('export-png')?.addEventListener('click', () => {
    const t = snapshotTargets()[parseInt(pngGraphSel?.value ?? '0', 10)];
    if (!t) return;
    const label = (document.getElementById('export-png-label') as HTMLInputElement | null)?.value.trim();
    hideExport?.();
    const g = t.graph;
    // Re-render synchronously so the WebGL trace buffer is populated when
    // snapshotPNG reads it back (it has no preserveDrawingBuffer).
    g.drawSync();
    // Back-to-front: axes/grid, then trace (graphCanvas), then phosphor overlay.
    const layers = [g.axisCanvas, g.graphCanvas];
    if (g.phosphor) layers.push(g.phosphor.canvas);
    snapshotPNG(layers, {
      title: t.title,
      label: label || undefined,
      filename: t.filename,
    });
  });

  // Window resize
  window.addEventListener('resize', () => layoutChanged.notify());

  // Start/pause (button + spacebar)
  const toggleCapture = (): void => {
    const dev = server.device as CEEDevice;
    if (!dev) return;
    if (dev.captureState) {
      dev.pauseCapture();
    } else {
      // Only begin capture once the deferred outputs are actually applied, so
      // a failure leaves the staged outputs intact for a retry.
      if (applyPendingOutputs()) dev.startCapture();
    }
  };
  document.getElementById('startpause')?.addEventListener('click', toggleCapture);

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    // Don't hijack space while typing in a field or focused on a control.
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || t?.isContentEditable) {
      return;
    }
    e.preventDefault(); // stop the page from scrolling
    toggleCapture();
  });

  captureState.subscribe((s) => {
    const btn = document.getElementById('startpause');
    // While paused with staged outputs, setPendingOutputs owns the title
    // (the "drives current" hint); don't clobber it here.
    if (btn && !(!s && pendingOutputs)) btn.title = s ? 'Pause' : defaultStartTitle;
    document.body.classList.toggle('capturing', !!s);
  });
}
