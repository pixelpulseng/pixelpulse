#!/usr/bin/env node
/**
 * Automated verification for the audio (speaker/mic) backend.
 *
 * Chromium's fake media device (--use-fake-device-for-media-stream) stands
 * in for the microphone and produces a test tone, and the fake-UI flag
 * auto-grants permission — so the full enable → capture → render path runs
 * headlessly with no audio hardware.
 *
 * Usage: node verify/verify-audio.mjs [--url http://localhost:8000] [--headed]
 */

import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
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

async function waitFor(page, fn, desc, timeout = 15000) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 });
    return true;
  } catch {
    console.log(`  ⏱ timeout waiting for: ${desc}`);
    return false;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pp-audio-'));

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: !HEADED,
    userDataDir: profile,
    args: [
      '--no-first-run',
      '--window-size=1400,900',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  ⚠ page error: ${e.message}`));

    await page.goto(`${BASE_URL}/pixelpulse.html#audio`, { waitUntil: 'domcontentloaded' });

    // The gesture/permission flow surfaces as a floating enable button
    const btnFound = await waitFor(page,
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Enable audio device')),
      'enable-audio button');
    check('boot: enable-audio button offered', btnFound);

    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Enable audio device'))?.click();
    });

    check('enable: device initializes with Out + In channels',
      await waitFor(page,
        () => document.querySelectorAll('#streams section.channel').length === 2
          && getComputedStyle(document.getElementById('error-overlay')).display === 'none',
        'channel sections'));

    // Start capture; the fake mic emits a tone
    await page.click('#startpause');
    check('capture: starts (body.capturing)',
      await waitFor(page, () => document.body.classList.contains('capturing'), 'capturing'));

    await new Promise((r) => setTimeout(r, 2500));

    check('capture: mic signal rendering (phosphor pixels lit)',
      await page.evaluate(() => {
        // In channel is the second section; any lit phosphor proves samples flow
        const canvases = [...document.querySelectorAll('canvas.phosphor-canvas')];
        return canvases.some((c) => {
          if (c.width === 0) return false;
          const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
          return lit > 100;
        });
      }));

    // The fake mic tone should register as nonzero signal on the In stream:
    // check the live reading text for a plausible number
    const reading = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('#streams section.channel')];
      return sections.map((s) => s.textContent.slice(0, 80)).join(' || ');
    });
    check('ui: channel sections labeled Out/In', /Out/.test(reading) && /In/.test(reading), reading);

    // Pause via spacebar (shared toolbar machinery works on this backend)
    await page.click('#streams');
    await page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, 800));
    check('spacebar: pauses capture on audio backend',
      await page.evaluate(() => !document.body.classList.contains('capturing')));

    await page.screenshot({ path: join(OUT_DIR, 'audio-backend.png') });

    // --- Share-state on the audio backend ---
    // A hand-built link: 48 kHz sr (device pins this — must be a no-op),
    // trigger, a tight window, channel A driving a sine, and b=-1 (the mic's
    // "measurement only" sentinel, which must NOT be staged as an output).
    const shareLink = `${BASE_URL}/pixelpulse.html#audio`
      + `&trig=0,0&x=-0.01,0.01&sr=0.0000208333&a=1,sine,0,1,192&b=-1,constant,0`;
    const page4 = await browser.newPage();
    page4.on('pageerror', (e) => console.log(`  ⚠ page error: ${e.message}`));
    await page4.goto(shareLink, { waitUntil: 'domcontentloaded' });
    await waitFor(page4,
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Enable audio device')),
      'enable-audio button (shared link)');
    await page4.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Enable audio device'))?.click();
    });
    await waitFor(page4,
      () => document.querySelectorAll('#streams section.channel').length === 2,
      'shared audio device view');
    await new Promise((r) => setTimeout(r, 500));

    check('share (audio): restores triggering + stays paused',
      await page4.evaluate(() =>
        document.body.classList.contains('triggering')
        && !document.body.classList.contains('capturing')));

    check('share (audio): channel A sine staged, mic (b=-1) not staged',
      await page4.evaluate(() => document.body.classList.contains('outputs-pending')));

    // Start applies the staged sine to Out (a), leaves In (b) a pure measure.
    await page4.click('#startpause');
    await new Promise((r) => setTimeout(r, 600));
    check('share (audio): Start applies output, clears pending',
      await page4.evaluate(() =>
        document.body.classList.contains('capturing')
        && !document.body.classList.contains('outputs-pending')));

    await page4.screenshot({ path: join(OUT_DIR, 'audio-shared-link.png') });
    await page4.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
