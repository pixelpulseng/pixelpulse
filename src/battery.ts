/**
 * LiPo capacity tester.
 *
 * Cell on channel A (+ to CHA, − to GND). Standard CC/CV charge then
 * constant-current discharge, coulomb-counting throughout:
 *
 *   per cycle:
 *     CC:  source +Ichg (SIMV) until Vpin >= Vmax
 *     CV:  hold Vmax (SVMI) until I <= cutoff
 *     rest: Hi-Z, settle, verify OCV = Vmax ± tol
 *     discharge: sink Idis (SIMV, negative) until Vpin <= Vend
 *   estimate = mean of the cycles' discharge capacity (mAh)
 *
 * Ends (including on error/abort) in Hi-Z. Results persist in localStorage.
 */

import { server, Listener, type CEEDevice, type Channel, type Stream } from './dataserver.js';

const HI_Z = 0, SVMI = 1, SIMV = 2;
const SETTLE_MS = 300;
const WINDOW_S = 1.0; // integration/measurement window
const REST_S = 5; // Hi-Z settle before the OCV check

// Per-phase watchdogs: generous for real cells (a 3000 mAh cell at 100 mA
// is a 30 h charge), still finite.
const CC_TIMEOUT_H = 48;
const CV_TIMEOUT_H = 8;
const DIS_TIMEOUT_H = 48;

const LS_KEY = 'm1k-battery-tests-v1';

interface TestConfig {
  cycles: number;
  finalState: 'charged' | 'discharged';
  chargeMA: number;
  dischargeMA: number;
  vmax: number;
  vend: number;
  cutoffMA: number;
  vtolMV: number;
}

interface CycleResult {
  chargeMAh: number; // CC + CV, total into the cell
  restV: number | null;
  dischargeMAh: number | null;
}

interface TestRecord {
  startedAt: number;
  finishedAt?: number;
  config: TestConfig;
  cycles: CycleResult[];
  status: 'running' | 'complete' | 'aborted' | 'error' | 'interrupted';
  error?: string;
}

interface Store { history: TestRecord[] }

// --- DOM helpers ---

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}
function show(id: string): void { el(id).style.display = ''; }
function hide(id: string): void { el(id).style.display = 'none'; }
function setText(id: string, text: string): void { el(id).textContent = text; }

function log(msg: string, cls?: string): void {
  const div = document.createElement('div');
  div.textContent = msg;
  if (cls) div.className = cls;
  el('log').appendChild(div);
  div.scrollIntoView({ block: 'nearest' });
}

// Background tabs get their timers throttled (Chrome's intensive throttling
// clamps page timers to once per MINUTE), which stretched the measurement
// loop until sample windows went stale and the test died. Worker timers are
// exempt, so all pacing sleeps are driven from a tiny dedicated worker.
const tickWorker: Worker | null = (() => {
  try {
    const src = 'onmessage=(e)=>setTimeout(()=>postMessage(e.data.id),e.data.ms)';
    return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch {
    return null; // fall back to page timers
  }
})();

let sleepSeq = 0;
const sleepWaiters = new Map<number, () => void>();
tickWorker?.addEventListener('message', (e: MessageEvent<number>) => {
  const wake = sleepWaiters.get(e.data);
  sleepWaiters.delete(e.data);
  wake?.();
});

const sleep = (ms: number) => new Promise<void>((r) => {
  if (!tickWorker) {
    setTimeout(r, ms);
    return;
  }
  const id = ++sleepSeq;
  sleepWaiters.set(id, r);
  tickWorker.postMessage({ id, ms });
});

// --- Device plumbing (mirrors m1k_calibrate) ---

let device: CEEDevice | null = null;

function chan(ch: 'a' | 'b'): Channel {
  if (!device) throw new Error('no device');
  return device.channels[ch];
}
function vStream(ch: 'a' | 'b'): Stream { return chan(ch).streams.v; }
function iStream(ch: 'a' | 'b'): Stream { return chan(ch).streams.i; }

async function setMode(ch: 'a' | 'b', mode: number, value = 0): Promise<void> {
  chan(ch).setConstant(mode, value);
  await sleep(SETTLE_MS);
}

// Mean V and I over `seconds` (one server-side boxcar average per stream)
function measure(seconds = WINDOW_S): Promise<{ v: number; i: number }> {
  return new Promise((resolve, reject) => {
    if (!device) return reject(new Error('no device'));
    const l = new Listener(device, [vStream('a'), iStream('a')]);
    const timer = setTimeout(() => { l.cancel(); reject(new Error('capture timed out')); }, 5000 + seconds * 1000);
    l.updated.subscribe((m) => {
      clearTimeout(timer);
      const v = m.data[0][m.data[0].length - 1];
      const i = m.data[1][m.data[1].length - 1];
      l.cancel();
      resolve({ v, i });
    });
    l.configure(false, seconds, 1);
    l.submit();
  });
}

// measure() with garbage rejection AND capture recovery. The Connect
// (WebSocket) backend encodes NaN samples as JSON null; listeners return
// exactly that when the device's capture has stalled (USB hiccup, suspend,
// capture left paused). Plain retries can't fix a stalled capture, so the
// ladder escalates: retry → restart capture → reconfigure + restart.
// `reapply` re-asserts the caller's drive mode after a reconfigure, which
// resets outputs — a charge phase must not be left un-driven.
async function measureValid(
  seconds = WINDOW_S,
  reapply?: () => Promise<void>,
  attempts = 6,
): Promise<{ v: number; i: number }> {
  for (let a = 1; ; a++) {
    const { v, i } = await measure(seconds);
    if (Number.isFinite(v) && Number.isFinite(i)) return { v, i };
    if (a >= attempts) {
      throw new TestAborted('error',
        'no valid samples from the device after capture-restart attempts — check USB/nonolith-connect');
    }
    log(`invalid sample window (v=${String(v)}, i=${String(i)}) — retrying ${a}/${attempts - 1}`, 'log-err');

    if (device && a >= 2 && !device.captureState) {
      log('capture is paused — restarting it', 'log-err');
      device.startCapture();
      await sleep(1500);
      await reapply?.();
    } else if (device && a >= 4) {
      // Capture claims to run but yields no data: reconfigure from scratch.
      // configure() resets outputs to 0, hence the reapply.
      log('capture running but yielding no data — reconfiguring device', 'log-err');
      device.configure({});
      device.startCapture();
      await sleep(1500);
      await reapply?.();
    }
    await sleep(1000);
  }
}

// Keep the machine awake for the duration of a test: a multi-hour capacity
// run dies (capture stall → null samples) if the system suspends.
let wakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // unsupported or denied — the retry logic is the fallback
  }
}

async function releaseWakeLock(): Promise<void> {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

// The lock is auto-released when the tab is hidden; re-acquire on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) void acquireWakeLock();
});

// --- Persistence ---

function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) ?? '');
    if (s && Array.isArray(s.history)) return s as Store;
  } catch { /* fresh */ }
  return { history: [] };
}

function saveStore(s: Store): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

let store = loadStore();

// --- Strip chart ---

interface ChartPoint { t: number; v: number; i: number }
let chartData: ChartPoint[] = [];

function drawChart(): void {
  const c = el<HTMLCanvasElement>('chart');
  const ctx = c.getContext('2d')!;
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (chartData.length < 2) return;

  const t0 = chartData[0].t;
  const t1 = chartData[chartData.length - 1].t;
  const tx = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * (W - 8) + 4;

  // Voltage 2.5..4.4 V (blue), current -220..220 mA (red)
  const vy = (v: number): number => H - ((v - 2.5) / (4.4 - 2.5)) * (H - 8) - 4;
  const iy = (i: number): number => H - ((i + 220) / 440) * (H - 8) - 4;

  const plot = (get: (p: ChartPoint) => number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    chartData.forEach((p, idx) => {
      const x = tx(p.t), y = get(p);
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  ctx.strokeStyle = '#ddd';
  ctx.beginPath();
  ctx.moveTo(0, iy(0));
  ctx.lineTo(W, iy(0));
  ctx.stroke();

  plot(p => vy(p.v), '#0064cd');
  plot(p => iy(p.i), '#c43c35');
}

// --- Test state machine ---

let running: TestRecord | null = null;
let abortRequested = false;

function fmtH(hours: number): string {
  const s = Math.round(hours * 3600);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function setState(text: string, cls = ''): void {
  const e = el('status-state');
  e.textContent = text;
  e.className = cls;
}

function updateReadouts(v: number | null, i: number | null, mah: number | null, startedAt: number | null): void {
  setText('ro-v', v == null ? '—' : `${v.toFixed(3)} V`);
  setText('ro-i', i == null ? '—' : `${i.toFixed(1)} mA`);
  setText('ro-mah', mah == null ? '—' : `${mah.toFixed(2)} mAh`);
  setText('ro-t', startedAt == null ? '—' : fmtH((Date.now() - startedAt) / 3600000));
}

class TestAborted extends Error {
  constructor(public why: 'aborted' | 'error', message: string) { super(message); }
}

function checkAbort(): void {
  if (abortRequested) throw new TestAborted('aborted', 'aborted by user');
}

// Run one phase: apply `apply`, then integrate 1 s windows until `until`
// says stop. Returns the accumulated charge in mAh (signed).
async function phase(
  name: string,
  apply: () => Promise<void>,
  until: (v: number, i: number) => boolean,
  timeoutH: number,
): Promise<number> {
  setState(name);
  await apply();
  let mah = 0;
  let lastT = performance.now();
  const phaseStart = lastT;
  for (;;) {
    checkAbort();
    const { v, i } = await measureValid(WINDOW_S, apply);
    const now = performance.now();
    const dtH = (now - lastT) / 3600000;
    lastT = now;
    // A monitoring gap (throttled/discarded tab, machine suspend) means the
    // threshold checks didn't run for dtH while the mode kept driving. The
    // constant-current integral over the gap is still correct (and CV only
    // tapers), so count it — but flag it, since a threshold crossing inside
    // the gap was seen late.
    if (dtH > (10 * WINDOW_S) / 3600) {
      log(`⚠ ${Math.round(dtH * 3600)} s monitoring gap — thresholds checked late; keep this page visible (own window) or exempt it from the browser's memory saver`, 'log-err');
    }
    mah += i * dtH;

    chartData.push({ t: now, v, i });
    if (chartData.length > 4000) chartData.splice(0, chartData.length - 4000);
    drawChart();
    updateReadouts(v, i, mah, running!.startedAt);
    saveStore(store); // keep the running record fresh for interrupted-detection

    if (until(v, i)) return mah;
    if ((now - phaseStart) / 3600000 > timeoutH) {
      throw new TestAborted('error', `${name}: timed out after ${timeoutH} h`);
    }
  }
}

async function chargeCell(cfg: TestConfig): Promise<number> {
  const cc = await phase(
    `charging ${cfg.chargeMA} mA (CC)`,
    () => setMode('a', SIMV, cfg.chargeMA),
    (v) => v >= cfg.vmax,
    CC_TIMEOUT_H,
  );
  const cv = await phase(
    `float at ${cfg.vmax.toFixed(2)} V (CV)`,
    () => setMode('a', SVMI, cfg.vmax),
    (_v, i) => i <= cfg.cutoffMA,
    CV_TIMEOUT_H,
  );
  return cc + cv;
}

async function runTest(cfg: TestConfig): Promise<void> {
  abortRequested = false;
  chartData = [];
  running = {
    startedAt: Date.now(),
    config: cfg,
    cycles: [],
    status: 'running',
  };
  store.history.unshift(running);
  saveStore(store);
  renderHistory();

  el<HTMLButtonElement>('btn-start').disabled = true;
  await acquireWakeLock();
  show('btn-abort');

  try {
    // Sanity: something battery-shaped is connected
    await setMode('b', HI_Z);
    await setMode('a', HI_Z);
    setState('checking cell');
    await sleep(500);
    const { v: ocv } = await measureValid(WINDOW_S, () => setMode('a', HI_Z));
    log(`Open-circuit voltage: ${ocv.toFixed(3)} V`);
    if (ocv < 2.8 || ocv > cfg.vmax + 0.05) {
      throw new TestAborted('error',
        `OCV ${ocv.toFixed(3)} V out of range (2.8–${(cfg.vmax + 0.05).toFixed(2)} V) — cell connected? (+ to CH A, − to GND)`);
    }

    for (let c = 0; c < cfg.cycles; c++) {
      setText('status-cycle', `cycle ${c + 1} of ${cfg.cycles}`);
      const cycle: CycleResult = { chargeMAh: 0, restV: null, dischargeMAh: null };
      running.cycles.push(cycle);

      cycle.chargeMAh = await chargeCell(cfg);
      log(`cycle ${c + 1}: charged in ${cycle.chargeMAh.toFixed(2)} mAh`);

      setState('resting (Hi-Z), verifying');
      await setMode('a', HI_Z);
      await sleep(REST_S * 1000);
      checkAbort();
      const { v: restV } = await measureValid(WINDOW_S, () => setMode('a', HI_Z));
      cycle.restV = restV;
      log(`cycle ${c + 1}: rest OCV ${restV.toFixed(3)} V`);
      if (Math.abs(restV - cfg.vmax) > cfg.vtolMV / 1000) {
        throw new TestAborted('error',
          `rest OCV ${restV.toFixed(3)} V not within ±${cfg.vtolMV} mV of ${cfg.vmax.toFixed(2)} V — check the cell/connection`);
      }

      const dmah = await phase(
        `discharging ${cfg.dischargeMA} mA`,
        () => setMode('a', SIMV, -cfg.dischargeMA),
        (v) => v <= cfg.vend,
        DIS_TIMEOUT_H,
      );
      cycle.dischargeMAh = -dmah; // sink current integrates negative
      log(`cycle ${c + 1}: discharge capacity ${cycle.dischargeMAh.toFixed(2)} mAh (${cfg.vmax.toFixed(2)}→${cfg.vend.toFixed(2)} V)`, 'log-ok');
      saveStore(store);
      renderHistory();
    }

    if (cfg.finalState === 'charged') {
      log('recharging to leave the cell full…');
      await chargeCell(cfg);
    }

    running.status = 'complete';
    setState('done', 'done');
    log(`test complete — estimate ${estimateOf(running)?.toFixed(2)} mAh`, 'log-ok');
  } catch (e) {
    if (e instanceof TestAborted) {
      running.status = e.why === 'aborted' ? 'aborted' : 'error';
      running.error = e.message;
      setState(e.why === 'aborted' ? 'aborted' : `error: ${e.message}`, 'error');
      log(`✗ ${e.message}`, 'log-err');
    } else {
      running.status = 'error';
      running.error = String(e);
      setState(`error: ${String(e)}`, 'error');
      log(`✗ ${String(e)}`, 'log-err');
      console.error(e);
    }
  } finally {
    // Fire the Hi-Z command immediately (send is synchronous; only the
    // settle sleep waits), then persist the final status BEFORE settling —
    // a tab closed right after "done" must not lose the result.
    let hiz: Promise<void> | null = null;
    try { hiz = setMode('a', HI_Z); } catch { /* device gone */ }
    running.finishedAt = Date.now();
    saveStore(store);
    renderHistory();
    try { await hiz; } catch { /* device gone */ }
    running = null;
    void releaseWakeLock();
    setText('status-cycle', '');
    el<HTMLButtonElement>('btn-start').disabled = false;
    hide('btn-abort');
  }
}

// --- History rendering ---

function estimateOf(t: TestRecord): number | null {
  const caps = t.cycles.map(c => c.dischargeMAh).filter((x): x is number => x != null);
  if (!caps.length) return null;
  return caps.reduce((a, b) => a + b, 0) / caps.length;
}

function renderHistory(): void {
  const tbody = el('history').querySelector('tbody')!;
  tbody.innerHTML = '';
  for (const t of store.history) {
    const tr = document.createElement('tr');
    const caps = t.cycles.map(c => c.dischargeMAh == null ? '…' : c.dischargeMAh.toFixed(1)).join(', ');
    const est = estimateOf(t);
    const cells = [
      new Date(t.startedAt).toLocaleString(),
      `${t.cycles.length}/${t.config.cycles}`,
      caps || '—',
      est == null ? '—' : `${est.toFixed(1)} mAh`,
      t.config.finalState,
      t.status + (t.error ? ` (${t.error})` : ''),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Any test with completed discharge cycles carries a usable estimate —
  // e.g. all 3 cycles done but marked 'interrupted' during a final recharge.
  const latest = store.history.find(t => t.status !== 'running' && estimateOf(t) != null);
  const est = latest ? estimateOf(latest) : null;
  const doneCycles = latest ? latest.cycles.filter(c => c.dischargeMAh != null).length : 0;
  const caveat = latest && latest.status !== 'complete' ? `, ${latest.status} test` : '';
  el('estimate').innerHTML = est == null
    ? '<span class="note">No completed test yet.</span>'
    : `Latest estimate: <b>${est.toFixed(1)} mAh</b> <span class="note">(${latest!.config.vmax.toFixed(2)} → ${latest!.config.vend.toFixed(2)} V at ${latest!.config.dischargeMA} mA, ${doneCycles} cycles${caveat})</span>`;
}

// --- Config + wiring ---

function readConfig(): TestConfig {
  const num = (id: string): number => parseFloat(el<HTMLInputElement>(id).value);
  return {
    cycles: Math.max(1, Math.round(num('inp-cycles'))),
    finalState: el<HTMLSelectElement>('inp-final').value as 'charged' | 'discharged',
    chargeMA: num('inp-ichg'),
    dischargeMA: num('inp-idis'),
    vmax: num('inp-vmax'),
    vend: num('inp-vend'),
    cutoffMA: num('inp-cutoff'),
    vtolMV: num('inp-vtol'),
  };
}

// Settings persist separately from test history, so "Clear session" wipes
// data but keeps preferences.
const LS_SETTINGS_KEY = 'm1k-battery-settings-v1';
const CONFIG_INPUTS = [
  'inp-cycles', 'inp-final', 'inp-ichg', 'inp-idis',
  'inp-vmax', 'inp-vend', 'inp-cutoff', 'inp-vtol',
];

function saveSettings(): void {
  const vals: Record<string, string> = {};
  for (const id of CONFIG_INPUTS) {
    vals[id] = el<HTMLInputElement | HTMLSelectElement>(id).value;
  }
  localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(vals));
}

function restoreSettings(): void {
  try {
    const vals = JSON.parse(localStorage.getItem(LS_SETTINGS_KEY) ?? '{}') as Record<string, string>;
    for (const id of CONFIG_INPUTS) {
      if (typeof vals[id] === 'string') {
        el<HTMLInputElement | HTMLSelectElement>(id).value = vals[id];
      }
    }
  } catch { /* defaults stand */ }
}

document.addEventListener('DOMContentLoaded', () => {
  // A test that was 'running' when the page was last unloaded was interrupted
  let dirty = false;
  for (const t of store.history) {
    if (t.status === 'running') {
      t.status = 'interrupted';
      t.error = 'page closed mid-test (device went Hi-Z on disconnect)';
      dirty = true;
    }
  }
  if (dirty) saveStore(store);
  renderHistory();

  restoreSettings();
  for (const id of CONFIG_INPUTS) {
    el(id).addEventListener('change', saveSettings);
  }

  el('btn-start').addEventListener('click', () => { void runTest(readConfig()); });
  el('btn-abort').addEventListener('click', () => { abortRequested = true; setState('aborting…'); });
  el('btn-clear').addEventListener('click', () => {
    if (running) return; // don't clear under a live test
    store = { history: [] };
    saveStore(store);
    renderHistory();
    log('session cleared');
  });
});

// --- Device session ---

let deviceInitialized = false;

function chooseDevice(): void {
  const m1k = server.devices.find(d => d.model === 'com.analogdevices.m1k');
  if (m1k) {
    if (device && device.id === m1k.id) return;
    deviceInitialized = false;
    device = server.selectDevice(m1k) as CEEDevice;
    device.changed.subscribe(onDeviceReady);
  } else {
    device = null;
    hide('main');
    show('no-device');
  }
}

function onDeviceReady(dev: CEEDevice): void {
  hide('no-device');
  hide('no-connect');
  show('main');
  setText('dev-info', `${dev.model} — hw ${dev.hwVersion}, fw ${dev.fwVersion}, serial ${dev.serial}`);

  if (deviceInitialized) return;
  deviceInitialized = true;

  // Diagnostic breadcrumb: a capture stall mid-test is otherwise invisible
  // until measurement windows come back null.
  dev.captureStateChanged.subscribe((s: boolean) => {
    if (running) log(`capture state changed: ${s ? 'running' : 'PAUSED'}`, s ? undefined : 'log-err');
  });

  if (!dev.captureState) {
    dev.configure({});
    dev.startCapture();
  }
}

server.connected.subscribe(() => hide('no-connect'));
server.devicesChanged.subscribe(chooseDevice);
server.connect();
