#!/usr/bin/env node
/**
 * Automated browser verification for pixelpulse.
 *
 * Drives the real UI in Chromium against the simulated M1K backend (#sim —
 * software LED/resistor loads; see src/smu/sim-device.ts), so no hardware or
 * human is needed. Checks boot, capture, stacked/overlay layouts, PNG export
 * (decoding the downloaded file to prove the WebGL readback isn't blank),
 * spacebar start/pause, and popup behavior.
 *
 * Usage:  node verify/verify.mjs [--url http://localhost:8000] [--headed]
 * Exit:   0 = all checks passed, 1 = failures (see stdout), 2 = harness error
 *
 * Screenshots and downloads land in verify/out/.
 */

import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROMIUM = process.env.CHROMIUM_BIN ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';
const BASE_URL = argValue('--url') ?? 'http://localhost:8000';
const HEADED = process.argv.includes('--headed');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(page, fn, desc, timeout = 10000) {
  try {
    await page.waitForFunction(fn, { timeout });
    return true;
  } catch {
    console.log(`  ⏱ timeout waiting for: ${desc}`);
    return false;
  }
}

// Decode an image file by drawing it onto a canvas inside the page, then
// measure how much of the plot area differs from the white background and
// whether the title bar is dark. This exercises a real PNG decode without
// any node-side image dependency.
async function analyzePNG(page, filePath) {
  const b64 = readFileSync(filePath).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonWhite = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) nonWhite++;
    }
    const bar = ctx.getImageData(5, 5, 1, 1).data;
    return {
      width: img.width,
      height: img.height,
      nonWhiteFraction: nonWhite / (px.length / 4),
      titleBarDark: bar[0] < 100 && bar[1] < 100 && bar[2] < 100,
    };
  }, b64);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pp-verify-'));
  const downloads = mkdtempSync(join(tmpdir(), 'pp-dl-'));

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: !HEADED,
    userDataDir: profile,
    args: ['--no-first-run', '--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: downloads, eventsEnabled: true,
    });
    page.on('pageerror', (e) => console.log(`  ⚠ page error: ${e.message}`));

    // --- Boot with simulated device ---
    await page.goto(`${BASE_URL}/pixelpulse.html#sim`, { waitUntil: 'domcontentloaded' });

    check('boot: device view initialized (channel sections present)',
      await waitFor(page,
        () => document.querySelectorAll('#streams section.channel').length === 2
          && getComputedStyle(document.getElementById('error-overlay')).display === 'none',
        'channel sections + overlay hidden'));

    // Start capture (the app boots paused, like real hardware)
    await page.click('#startpause');
    check('boot: capture starts via Start button (body.capturing)',
      await waitFor(page, () => document.body.classList.contains('capturing'), 'body.capturing'));

    // Let the sim stream for a moment so traces have content
    await new Promise((r) => setTimeout(r, 1500));

    check('boot: backend dropdown reflects active backend (sim)',
      await page.evaluate(() => document.getElementById('backend-select')?.value === 'sim'));

    // --- Default layout ---
    check('default: stacked view visible, overlay pane hidden',
      await page.evaluate(() =>
        getComputedStyle(document.getElementById('streams')).display !== 'none'
        && getComputedStyle(document.getElementById('overlay')).display === 'none'
        && !document.body.classList.contains('overlay-mode')));

    // Phosphor canvases are 2D — read pixels directly to prove live traces
    check('default: phosphor trace has rendered content',
      await page.evaluate(() => {
        const c = document.querySelector('canvas.phosphor-canvas');
        if (!c || c.width === 0) return false;
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
        return lit > 100;
      }));

    await page.screenshot({ path: join(OUT_DIR, '1-stacked.png') });

    // --- Overlay mode ---
    await page.click('#overlaybtn');
    check('overlay: pane shown, button active, stacked hidden',
      await waitFor(page,
        () => document.body.classList.contains('overlay-mode')
          && getComputedStyle(document.getElementById('overlay')).display !== 'none'
          && getComputedStyle(document.getElementById('streams')).display === 'none',
        'overlay-mode engaged'));

    check('overlay: 4 trace rows, 2 voltage traces enabled by default',
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#overlay-controls .overlay-row');
        const checked = document.querySelectorAll('#overlay-controls input[type=checkbox]:checked');
        return rows.length === 4 && checked.length === 2;
      }));

    check('overlay: per-div dropdowns show a selected value matching state',
      await page.evaluate(() =>
        [...document.querySelectorAll('#overlay-controls select.overlay-perdiv')]
          .every((s) => s.selectedIndex >= 0 && s.value !== '')));

    check('overlay: position readouts present',
      await page.evaluate(() =>
        document.querySelectorAll('#overlay-controls output.overlay-pos-val').length === 4));

    // Enable a current trace too (3rd row = B Voltage? rows are A.v, A.i, B.v, B.i)
    await page.evaluate(() => {
      document.querySelectorAll('#overlay-controls .overlay-row input[type=checkbox]')[1].click();
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: join(OUT_DIR, '2-overlay.png') });

    // Triggering in overlay mode: the trigger-level line (TriggerOverlay's
    // 10px triangle canvas) must appear on the overlay graph and track state
    await page.click('#triggerbtn');
    check('overlay: trigger line appears when triggering enabled',
      await waitFor(page,
        () => !!document.querySelector('#overlay-graph div > canvas[width="10"]'),
        'trigger overlay element'));
    await page.click('#triggerbtn');
    check('overlay: trigger line removed when triggering disabled',
      await waitFor(page,
        () => !document.querySelector('#overlay-graph div > canvas[width="10"]'),
        'trigger overlay removed'));

    // --- Export popup + targets ---
    await page.click('#download-btn');
    check('export: popup opens',
      await waitFor(page,
        () => getComputedStyle(document.getElementById('export-popup')).display !== 'none',
        'export popup visible'));

    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('#export-png-graph option')].map((o) => o.textContent));
    check('export: overlay listed first + 4 channel targets, all unique',
      targets.length === 5 && targets[0] === 'Overlay' && new Set(targets).size === 5,
      targets.join(' | '));

    await page.screenshot({ path: join(OUT_DIR, '3-export-popup.png') });

    // --- PNG snapshot download (overlay target: exercises WebGL readback) ---
    await page.select('#export-png-graph', '0');
    await page.type('#export-png-label', 'sim verification');
    await page.click('#export-png');

    let pngPath = null;
    for (let i = 0; i < 40 && !pngPath; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const f = readdirSync(downloads).find((n) => n.endsWith('.png'));
      if (f && statSync(join(downloads, f)).size > 0) pngPath = join(downloads, f);
    }
    check('export: PNG downloaded', !!pngPath, pngPath ?? 'no file appeared');

    if (pngPath) {
      const a = await analyzePNG(page, pngPath);
      check('export: PNG has dark title bar and non-blank plot (WebGL readback)',
        a.titleBarDark && a.nonWhiteFraction > 0.02,
        `${a.width}x${a.height}, nonWhite=${(a.nonWhiteFraction * 100).toFixed(1)}%, bar=${a.titleBarDark}`);
    }

    check('export: popup closed after save',
      await page.evaluate(() =>
        getComputedStyle(document.getElementById('export-popup')).display === 'none'));

    // --- Overlay off restores stacked view ---
    await page.click('#overlaybtn');
    check('overlay off: stacked view restored',
      await waitFor(page,
        () => !document.body.classList.contains('overlay-mode')
          && getComputedStyle(document.getElementById('streams')).display !== 'none',
        'stacked view back'));

    // Export picker should no longer offer the overlay
    await page.click('#download-btn');
    const targets2 = await page.evaluate(() =>
      [...document.querySelectorAll('#export-png-graph option')].map((o) => o.textContent));
    check('export: overlay target removed when overlay disabled',
      targets2.length === 4 && !targets2.includes('Overlay'), targets2.join(' | '));
    await page.keyboard.press('Escape');
    await page.click('body'); // dismiss popup via outside click

    // --- Configure popup closes on Apply ---
    await page.click('#device-config');
    const configOpen = await waitFor(page,
      () => getComputedStyle(document.getElementById('config-popup')).display !== 'none',
      'config popup visible');
    await page.click('#device-config-apply');
    check('configure: popup closes on Apply',
      configOpen && await waitFor(page,
        () => getComputedStyle(document.getElementById('config-popup')).display === 'none',
        'config popup hidden'));

    // Applying a config pauses capture (driver.configure semantics) — the
    // spacebar test below works from whichever state we're in.
    await new Promise((r) => setTimeout(r, 500));

    // --- Spacebar toggles start/pause ---
    await page.click('#streams'); // focus somewhere neutral
    const beforeSpace = await page.evaluate(() => document.body.classList.contains('capturing'));
    await page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, 1000));
    const nowCapturing = await page.evaluate(() => document.body.classList.contains('capturing'));
    check('spacebar: toggles capture', nowCapturing !== beforeSpace,
      `${beforeSpace} -> ${nowCapturing}`);
    await page.keyboard.press('Space'); // restore

    await page.screenshot({ path: join(OUT_DIR, '4-final.png') });

    // --- No-device state: backend chooser must stay usable ---
    // Plain load (WebUSB backend, headless = no device) shows the error
    // overlay; the toolbar must sit above it so the user can switch backends.
    const page2 = await browser.newPage();
    await page2.goto(`${BASE_URL}/pixelpulse.html`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1000));
    check('no-device: backend dropdown clickable above error overlay',
      await page2.evaluate(() => {
        const sel = document.getElementById('backend-select');
        if (!sel) return false;
        const r = sel.getBoundingClientRect();
        if (r.width === 0) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === sel;
      }));
    await page2.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  console.log(`screenshots: ${OUT_DIR}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
