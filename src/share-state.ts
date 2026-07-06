/**
 * Shareable app state via URL hash parameters.
 *
 * The whole current configuration — layout, overlay/phosphor/trigger, x-axis
 * window, sample rate, and per-channel output sources — is serialized into a
 * handful of `key=value` tokens appended to the location hash, after the
 * backend-selection flags (#sim / #connect / #audio / bat=...). Those backend
 * flags are preserved because they never collide with the keys below.
 *
 * Two directions:
 *   - capture(): read live state → write tokens into the hash (debounced;
 *     driven by the app's change events so the URL bar always reflects state).
 *   - restore(): parse tokens on load and apply them through the normal
 *     setters. Restore is SAFE: the app boots paused, and channel outputs are
 *     held Hi-Z on the device until the user first presses Start — a shared
 *     link never drives current into attached hardware during preview.
 *
 * Keys (all optional; omitted when at their default):
 *   layout=N            side-graph pane count 0..2
 *   sg1=xi,yi sg2=xi,yi side-graph stream index pairs (only if non-default)
 *   ov=1                overlay mode on
 *   ovN=perDiv,pos,en   per-overlay-trace (N = stream index): units/div,
 *                       position (div), enabled (1/0)
 *   ph=0                phosphor off (default is on)
 *   trig=si,level       trigger on: source stream index, level
 *   x=min,max           x-axis visible window (seconds)
 *   sr=sampleTime       sample time (s/sample)
 *   <chId>=mode,src,... per-channel output source (chId = 'a'/'b'):
 *                         constant: mode,constant,value
 *                         periodic: mode,src,offset,amplitude,period
 *   Numbers are compacted (trailing-zero-trimmed) to keep links short.
 */

import { type CEEDevice, type Channel, type OutputSource, server } from './dataserver.js';
import type { ShareStateApi } from './views.js';

// Keys we own — anything matching these is stripped before we rewrite, so a
// re-share doesn't accumulate stale tokens. Backend flags don't match.
const OWNED_KEY = /^(layout|sg1|sg2|ov|ov\d+|ph|trig|x|sr|[ab])=/;

// --- number formatting ---

// Compact a number for the URL: fixed-ish but with trailing zeros trimmed.
function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Enough precision for setpoints/levels without exponential noise.
  return parseFloat(n.toPrecision(6)).toString();
}

function parseNum(s: string | undefined): number | null {
  if (s == null || s === '') return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

// --- hash token I/O ---

function readTokens(): string[] {
  return location.hash.slice(1).split('&').filter(Boolean);
}

// Replace our owned tokens with `mine`, preserving everything else (backend
// flags, perfstat, etc.) in place at the front.
function writeTokens(mine: string[]): void {
  const kept = readTokens().filter(t => !OWNED_KEY.test(t));
  const next = [...kept, ...mine].join('&');
  if (next === location.hash.slice(1)) return;
  // Avoid a history entry per keystroke; keep the URL bar live without spam.
  const url = `${location.pathname}${location.search}#${next}`;
  history.replaceState(null, '', url);
}

function tokenMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of readTokens()) {
    const eq = t.indexOf('=');
    if (eq > 0) m.set(t.slice(0, eq), t.slice(eq + 1));
  }
  return m;
}

// --- serialization ---

function serializeSource(src: OutputSource): string | null {
  const mode = typeof src.mode === 'string'
    ? (src.mode === 'SVMI' ? 1 : src.mode === 'SIMV' ? 2 : 0)
    : src.mode;
  if (!mode) return null; // Hi-Z (0) is the default — don't serialize.

  if (src.source === 'constant') {
    return `${mode},constant,${num(src.value ?? 0)}`;
  }
  if (src.source === 'sine' || src.source === 'triangle' || src.source === 'square') {
    return [
      mode, src.source,
      num(src.offset ?? 0), num(src.amplitude ?? 0), num(src.period ?? 0),
    ].join(',');
  }
  // adv_square / arb: skip (rare; the device keeps its own state). A future
  // extension can add them without breaking older links.
  return null;
}

// --- public: capture live state into the hash ---

let api: ShareStateApi | null = null;
let writeQueued = false;

export function captureNow(): void {
  if (!api) return;
  const dev = server.device as CEEDevice | null;
  if (!dev) return;

  const tokens: string[] = [];

  // Layout + side-graph axes
  const layout = api.getLayout();
  if (layout > 0) {
    tokens.push(`layout=${layout}`);
    const sg = api.getSideGraphs();
    if (sg[0] && !sg[0].isDefault) tokens.push(`sg1=${sg[0].x},${sg[0].y}`);
    if (sg[1] && !sg[1].isDefault) tokens.push(`sg2=${sg[1].x},${sg[1].y}`);
  }

  // Overlay
  if (api.getOverlayMode()) {
    tokens.push('ov=1');
    for (const t of api.getOverlayTraces()) {
      tokens.push(`ov${t.index}=${num(t.perDiv)},${num(t.position)},${t.enabled ? 1 : 0}`);
    }
  }

  // Phosphor (default on → only serialize when off)
  if (!api.getPhosphor()) tokens.push('ph=0');

  // Trigger
  const trig = api.getTrigger();
  if (trig) tokens.push(`trig=${trig.streamIndex},${num(trig.level)}`);

  // X-axis window (skip the default -10..0 to keep links minimal)
  const x = api.getXWindow();
  if (x && !(x.min === -10 && x.max === 0)) {
    tokens.push(`x=${num(x.min)},${num(x.max)}`);
  }

  // Sample rate
  tokens.push(`sr=${num(dev.sampleTime)}`);

  // Per-channel output sources
  for (const ch of Object.values(dev.channels) as Channel[]) {
    const s = serializeSource(ch.source);
    if (s) tokens.push(`${ch.id}=${s}`);
  }

  writeTokens(tokens);
}

// Debounced: many events fire in a burst (e.g. zoom drags). Coalesce to one
// hash write per frame.
export function scheduleCapture(): void {
  if (writeQueued) return;
  writeQueued = true;
  requestAnimationFrame(() => {
    writeQueued = false;
    captureNow();
  });
}

// --- public: restore from the hash on load ---

export interface RestorePlan {
  layout?: number;
  sideGraphs: { slot: 1 | 2; x: number; y: number }[];
  overlay?: boolean;
  overlayTraces: { index: number; perDiv: number; position: number; enabled: boolean }[];
  phosphor?: boolean;
  trigger?: { streamIndex: number; level: number };
  xWindow?: { min: number; max: number };
  sampleTime?: number;
  // Channel outputs are held for the first Start; keyed by channel id.
  channelOutputs: Map<string, OutputSource>;
}

// True when a shared config is present — the caller uses this to decide
// whether outputs must be deferred (held Hi-Z) until first Start.
export function hasShareState(): boolean {
  for (const k of tokenMap().keys()) {
    if (/^(layout|ov|ph|trig|x|sr|a|b)$/.test(k) || /^ov\d+$/.test(k)) return true;
  }
  return false;
}

function parseSource(spec: string): OutputSource | null {
  const p = spec.split(',');
  const mode = parseNum(p[0]);
  const source = p[1];
  if (mode == null || !source) return null;

  if (source === 'constant') {
    const value = parseNum(p[2]);
    if (value == null) return null;
    return { mode, source: 'constant', value };
  }
  if (source === 'sine' || source === 'triangle' || source === 'square') {
    const offset = parseNum(p[2]);
    const amplitude = parseNum(p[3]);
    const period = parseNum(p[4]);
    if (offset == null || amplitude == null || period == null) return null;
    return { mode, source, offset, amplitude, period };
  }
  return null;
}

export function parseRestorePlan(): RestorePlan {
  const m = tokenMap();
  const plan: RestorePlan = {
    sideGraphs: [],
    overlayTraces: [],
    channelOutputs: new Map(),
  };

  const layout = parseNum(m.get('layout'));
  if (layout != null) plan.layout = Math.max(0, Math.min(2, Math.round(layout)));

  for (const [key, slot] of [['sg1', 1], ['sg2', 2]] as const) {
    const v = m.get(key);
    if (!v) continue;
    const [x, y] = v.split(',').map(parseNum);
    if (x != null && y != null) plan.sideGraphs.push({ slot, x, y });
  }

  if (m.get('ov') === '1') plan.overlay = true;
  for (const [key, v] of m) {
    const om = /^ov(\d+)$/.exec(key);
    if (!om) continue;
    const [perDiv, position, en] = v.split(',');
    const pd = parseNum(perDiv);
    const pos = parseNum(position);
    if (pd != null && pos != null) {
      plan.overlayTraces.push({
        index: parseInt(om[1], 10),
        perDiv: pd,
        position: pos,
        enabled: en !== '0',
      });
    }
  }

  if (m.get('ph') === '0') plan.phosphor = false;

  const trig = m.get('trig');
  if (trig) {
    const [si, level] = trig.split(',').map(parseNum);
    if (si != null && level != null) plan.trigger = { streamIndex: si, level };
  }

  const x = m.get('x');
  if (x) {
    const [min, max] = x.split(',').map(parseNum);
    if (min != null && max != null && min < max) plan.xWindow = { min, max };
  }

  const sr = parseNum(m.get('sr'));
  if (sr != null && sr > 0) plan.sampleTime = sr;

  for (const id of ['a', 'b']) {
    const spec = m.get(id);
    if (!spec) continue;
    const src = parseSource(spec);
    if (src) plan.channelOutputs.set(id, src);
  }

  return plan;
}

// --- wiring ---

export function bindShareState(a: ShareStateApi): void {
  api = a;
}

// Build a shareable absolute URL for the current state (captures first so the
// hash is fresh), for the Share button.
export function shareUrl(): string {
  captureNow();
  return location.href;
}
