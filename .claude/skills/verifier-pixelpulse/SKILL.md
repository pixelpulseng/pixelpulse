---
name: verifier-pixelpulse
description: Automated browser verification for the pixelpulse GUI. Use when verifying UI changes to pixelpulse (graphs, overlay mode, exports, toolbar, popups) — runs the real app in Chromium against a simulated M1K, no hardware or human needed.
---

# Pixelpulse browser verifier

Runs the full pixelpulse UI in Chromium against the **simulated M1K backend**
(`#sim` URL hash): a software device with an LED load on channel A and a
100 Ω-to-2.5 V load on channel B (`src/smu/sim-device.ts`). All real code
paths above the driver (dataserver, listeners, triggering, decimation, UI)
are exercised.

## Run

```bash
# dev server must be running (npm run dev, default port 8000)
npm run verify              # main pixelpulse UI (27 checks)
npm run verify:battery      # LiPo capacity-test applet (14 checks, ~1 min)
npm run verify:audio        # speaker/mic backend (#audio) via Chromium fake media
node verify/verify.mjs --headed         # watch it drive
node verify/verify.mjs --url http://localhost:5173   # other port
```

- Exit 0 = all checks passed; 1 = failures (listed on stdout); 2 = harness error.
- Screenshots land in `verify/out/` (stacked view, overlay, export popup, final).
- Downloads (exported PNGs) are validated in-page: decoded onto a canvas,
  checked for a dark title bar and non-blank plot — this is the WebGL
  readback proof.
- Chromium binary: `/Applications/Chromium.app/Contents/MacOS/Chromium`
  (override with `CHROMIUM_BIN`). Uses a fresh temp profile per run; never
  touches the user's browser.

## What it covers

Boot + device init, Start button, stacked layout default, phosphor pixels
rendering, overlay mode (rows/defaults/readouts/dropdown integrity), export
popup targets (incl. overlay only-when-enabled), PNG snapshot download +
decode, Configure popup closes on Apply, spacebar start/pause, and
shareable-state URLs (Share button writes tokens; a hand-built link restores
overlay/phosphor/trigger and holds channel outputs Hi-Z until Start).

## Shareable state (URL params)

`src/share-state.ts` serializes UI/device state into hash tokens after the
backend flags: `layout`, `sg1`/`sg2` (side-graph stream indices), `ov` +
`ov<i>` (overlay traces: perDiv,pos,enabled), `ph=0`, `trig=streamIdx,level`,
`x=min,max`, `sr=sampleTime`, and per-channel `a=`/`b=` output source
(`mode,constant,value` or `mode,shape,offset,amplitude,period`). The URL bar
stays live (debounced `history.replaceState`); the Share button copies it.
Restore is safe: the app opens paused and channel outputs are held Hi-Z
(`body.outputs-pending`) until the first Start — a link never drives current
during preview. Defaults are omitted (phosphor-on, Hi-Z, -10..0 window).

## Battery applet

`battery.html#sim&bat=<mAh>` gives the sim a battery model on channel A
(OCV = 3.0 + 1.2·SOC, 1 Ω series R — a 4.2 V CV hold tapers to 10 mA at
Voc 4.19 V like a real CC/CV tail). `bat=0.5` makes a full
charge/rest/discharge cycle finish in ~30 s. Expected discharge capacity
for the model: ≈ 0.32 × capacity (4.2 → 3.7 V window).

## Extending

Add checks in `verify/verify.mjs` via `check(name, ok, detail)`. To verify
signal-dependent features (triggering, bode, V-I sweeps), drive the source
UI first — the sim responds physically (diode I-V on A, linear on B).
Manual exploration: open `http://localhost:8000/pixelpulse.html#sim`.
