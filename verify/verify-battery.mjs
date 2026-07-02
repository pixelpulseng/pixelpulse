#!/usr/bin/env node
/**
 * Automated verification for the LiPo capacity-test applet.
 *
 * Runs battery.html against the simulated M1K with a tiny (0.5 mAh) battery
 * model on channel A (#sim&bat=0.5), so a full 1-cycle CC/CV/rest/discharge
 * test completes in under a minute. Asserts the state machine walks the
 * phases, the estimate is physically plausible for the model, history
 * persists across a reload, and Clear session empties it.
 *
 * Expected capacity: OCV 3.0+1.2*SOC, R=1Ω, CV to 10 mA → SOC ≈ 0.99;
 * discharge at 100 mA to Vpin 3.7 → Voc 3.8 → SOC ≈ 0.667.
 * ΔSOC ≈ 0.32 × 0.5 mAh ≈ 0.16 mAh (loose bounds 0.08–0.30).
 *
 * Usage: node verify/verify-battery.mjs [--url http://localhost:8000] [--headed]
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
  const profile = mkdtempSync(join(tmpdir(), 'pp-bat-'));

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: !HEADED,
    userDataDir: profile,
    args: ['--no-first-run', '--window-size=1100,900'],
    defaultViewport: { width: 1100, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  ⚠ page error: ${e.message}`));

    const url = `${BASE_URL}/battery.html#sim&bat=0.5`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    check('boot: applet initialized with sim device',
      await waitFor(page,
        () => getComputedStyle(document.getElementById('main')).display !== 'none'
          && document.getElementById('dev-info').textContent.includes('m1k'),
        'main visible + dev info'));

    // 1 cycle, leave discharged (fastest path)
    await page.evaluate(() => {
      document.getElementById('inp-cycles').value = '1';
      document.getElementById('inp-final').value = 'discharged';
    });
    await page.click('#btn-start');

    check('start: abort button appears, test running',
      await waitFor(page,
        () => getComputedStyle(document.getElementById('btn-abort')).display !== 'none',
        'abort visible'));

    // Watch the state machine walk its phases
    const sawCharging = await waitFor(page,
      () => document.getElementById('status-state').textContent.includes('charging'),
      'CC charging state', 20000);
    check('phase: CC charge', sawCharging);

    const sawCV = await waitFor(page,
      () => document.getElementById('status-state').textContent.includes('float'),
      'CV float state', 60000);
    check('phase: CV float', sawCV);

    const sawDischarge = await waitFor(page,
      () => document.getElementById('status-state').textContent.includes('discharging'),
      'discharge state (incl. rest/verify passed)', 60000);
    check('phase: rest/verify then discharge', sawDischarge);

    const done = await waitFor(page,
      () => document.getElementById('status-state').textContent === 'done',
      'test complete', 90000);
    check('test completes', done,
      await page.evaluate(() => document.getElementById('status-state').textContent));

    await page.screenshot({ path: join(OUT_DIR, 'battery-done.png') });

    // The final status must be persisted promptly after "done" (a closed
    // tab must not lose the result) — short timeout is deliberate.
    check('history: final status persisted promptly',
      await waitFor(page,
        () => JSON.parse(localStorage.getItem('m1k-battery-tests-v1')).history[0].status !== 'running',
        'persisted status leaves running', 2000));

    // Estimate plausibility against the battery model
    const est = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('m1k-battery-tests-v1'));
      const t = s.history[0];
      const caps = t.cycles.map((c) => c.dischargeMAh).filter((x) => x != null);
      return {
        status: t.status,
        cycles: t.cycles.length,
        capacity: caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : null,
        restV: t.cycles[0]?.restV,
      };
    });
    check('history: recorded complete 1-cycle test',
      est.status === 'complete' && est.cycles === 1, JSON.stringify(est));
    check('estimate physically plausible for the 0.5 mAh model (0.08–0.30 mAh)',
      est.capacity != null && est.capacity > 0.08 && est.capacity < 0.30,
      `${est.capacity?.toFixed(3)} mAh, rest OCV ${est.restV?.toFixed(3)} V`);

    // Persistence across reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(page,
      () => getComputedStyle(document.getElementById('main')).display !== 'none',
      'main visible after reload');
    const rows = await page.evaluate(() =>
      document.querySelectorAll('#history tbody tr').length);
    check('persistence: history survives reload (localStorage)', rows === 1, `${rows} rows`);

    const estimateShown = await page.evaluate(() =>
      document.getElementById('estimate').textContent.includes('mAh'));
    check('persistence: estimate rendered from stored data', estimateShown);

    // Clear session
    await page.click('#btn-clear');
    const cleared = await page.evaluate(() =>
      document.querySelectorAll('#history tbody tr').length === 0
      && JSON.parse(localStorage.getItem('m1k-battery-tests-v1')).history.length === 0);
    check('clear session empties history + storage', cleared);
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
