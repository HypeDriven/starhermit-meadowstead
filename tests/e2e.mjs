/**
 * Meadowstead — automated QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (system Chrome + swiftshader):
 *   title → journey stage 1 setup → full session played to the results screen
 *   (plant/water/harvest/fulfill driven by a greedy strategy synced off the
 *   game's own saved snapshot in localStorage; every action goes through real
 *   buttons/keys) → retry → hint → pause/resume → settings open/toggle/close →
 *   leave back to title. Runs twice: desktop 1280x800 and mobile 390x844
 *   (touch). On desktop plots are clicked in the on-screen board mirror; on
 *   mobile (where the mirror is hidden by the portrait media query) plots are
 *   driven with the game's keyboard controls (arrows + Enter).
 *
 * Self-contained: starts its own static server on an ephemeral port and stubs
 * the /api/v1 platform endpoints (time/telemetry/achievements) so the game's
 * online probe succeeds without the authoritative server. The repo's server.js
 * is the StarHermit authoritative server and is intentionally NOT used here.
 *
 * Screenshots land in /tmp/meadowstead-e2e-<stage>-<desktop|mobile>.png.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, pass) => `/tmp/meadowstead-e2e-${stage}-${pass}.png`;

// benign GPU/swiftshader noise (same regex as tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/typescript',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // stub platform API so the client's online probe succeeds offline
  if (url.pathname.startsWith('/api/v1/')) {
    const body = url.pathname === '/api/v1/time' ? { now: Date.now() } : { ok: true, rows: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

let exitCode = 0;
try {
  await playPass({ pass: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false, mobile: false });
  await playPass({ pass: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, mobile: true });
} catch (e) {
  exitCode = 1;
  console.error('E2E FAIL:', e && e.message ? e.message : e);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

if (!exitCode) console.log('\nE2E PASS — desktop + mobile playthroughs, no page errors');
process.exitCode = exitCode;

/* ------------------------------------------------------------------ */

async function playPass({ pass, viewport, hasTouch, mobile }) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${pass}] ${name}`);
  };

  // Greedy next-action decision, mirrored from the rules engine's own content
  // validator bot, synced off the snapshot the game persists after every move.
  const nextAction = () => page.evaluate(() => {
    const R = window.MeadowRules;
    const raw = localStorage.getItem('meadowstead:snapshot');
    if (!raw) return { done: true };
    const st = R.deserialize(JSON.parse(raw).state);
    if (st.terminalReason) return { done: true };
    const legal = R.legalActions(st);
    const unmet = {};
    for (const o of st.orders) {
      for (const [k, n] of Object.entries(o.needs)) {
        unmet[k] = Math.max(unmet[k] || 0, n - (st.inventory[k] || 0));
      }
    }
    const pick =
      legal.find((a) => a.type === 'fulfill') ||
      legal.find((a) => a.type === 'harvest') ||
      legal.find((a) => a.type === 'water') ||
      legal.find((a) => a.type === 'craft' && unmet[a.recipe] > 0) ||
      legal.filter((a) => a.type === 'plant' && unmet[a.crop] > 0)
        .sort((a, b) => unmet[b.crop] - unmet[a.crop])[0] ||
      legal.find((a) => a.type === 'plant') ||
      legal.find((a) => a.type === 'craft') ||
      { type: 'wait' };
    return { done: false, action: pick, tick: st.tick, fulfilled: st.ordersFulfilled, goal: st.goalOrders };
  });

  // Tool buttons toggle when re-clicked, so only click when not already active.
  const ensureTool = async (sel) => {
    const active = await page.locator(sel).evaluate((b) => b.classList.contains('active'));
    if (!active) await page.click(sel);
  };
  const CROP_KEY = { turnip: '1', carrot: '2', pumpkin: '3' };

  // mobile: board mirror is display:none on portrait phones, so plots are
  // driven with the game's keyboard controls. The real selection is read back
  // from the mirror buttons' .selected class (set even while visually hidden),
  // because ArrowRight from no selection lands on plot 1, not 0.
  const actOnPlot = async (tool, p, crop) => {
    if (mobile) {
      await page.keyboard.press(tool === 'plant' ? CROP_KEY[crop] : tool === 'water' ? 'w' : 'h');
      let cur = await page.evaluate(() =>
        [...document.querySelectorAll('#board-mirror button')].findIndex((b) => b.classList.contains('selected')));
      const total = await page.locator('#board-mirror button').count();
      if (cur < 0) { await page.keyboard.press('ArrowLeft'); cur = total - 1; }
      let steps = (p - cur + total) % total;
      while (steps-- > 0) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
    } else {
      await ensureTool(tool === 'plant' ? `[data-crop="${crop}"]` : `[data-tool="${tool}"]`);
      await page.locator('#board-mirror button').nth(p).click();
    }
  };

  const doAction = async (a) => {
    if (a.type === 'wait') {
      if (mobile) await page.keyboard.press(' ');
      else await page.click('[data-tool="wait"]');
    } else if (a.type === 'fulfill') {
      if (mobile && !(await page.locator('#rail-left.open').count())) {
        await page.click('#btn-drawer-left');
        await page.waitForSelector('#rail-left.open');
      }
      await page.locator('#orders-list li.fulfillable button').first().click();
    } else if (a.type === 'craft') {
      await page.locator(`#craft-list button[aria-label*="${a.recipe === 'salad' ? 'Garden Salad' : 'Harvest Pie'}"]`).click();
    } else {
      await actOnPlot(a.type, a.plot, a.crop);
    }
    await page.waitForTimeout(40);
  };

  try {
    await step('load + title visible', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('#screen-title.open', { timeout: 15000 });
      await page.screenshot({ path: SHOT('title', pass) });
    });

    await step('journey stage 1 setup', async () => {
      await page.click('#btn-journey');
      await page.waitForSelector('#screen-setup.open');
      const details = await page.textContent('#setup-details');
      if (!/Stage 1\/40/.test(details)) throw new Error('unexpected setup details: ' + details);
      await page.screenshot({ path: SHOT('setup', pass) });
    });

    await step('start session → playing with HUD', async () => {
      await page.click('#btn-start-session');
      await page.waitForFunction(() => !document.querySelector('#screens .screen.open'));
      const hud = (await page.textContent('#sb-tick')).trim();
      if (!/^Time 0\//.test(hud)) throw new Error('HUD not in play state: ' + hud);
      if ((await page.locator('#board-mirror button').count()) !== 8) {
        throw new Error('journey stage 1 should have 8 plots');
      }
    });

    await step('play journey stage 1 to results (greedy, via UI)', async () => {
      let shotTaken = false;
      for (let i = 0; i < 60; i++) {
        if (await page.locator('#screen-results.open').count()) break;
        const d = await nextAction();
        if (d.done) break;
        await doAction(d.action);
        if (!shotTaken && d.tick >= 2) {
          await page.screenshot({ path: SHOT('play', pass) });
          shotTaken = true;
        }
      }
      await page.waitForSelector('#screen-results.open', { timeout: 5000 });
    });

    await step('results screen with score breakdown', async () => {
      const rows = await page.locator('#score-breakdown tbody tr').count();
      if (rows !== 6) throw new Error(`expected 6 breakdown rows, got ${rows}`);
      const headline = (await page.textContent('#results-headline')).trim();
      const total = (await page.textContent('#score-total')).trim();
      console.log(`  [${pass}] headline: ${headline} | total: ${total}`);
      if (!/goal complete/.test(headline)) throw new Error('stage 1 not completed: ' + headline);
      // completing stage 1 must unlock stage 2 (regression: progression used to be
      // gated on a configRef field the rules engine never sets on the state)
      const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('meadowstead:progress')));
      if (prog.journeyStage !== 2) throw new Error(`journeyStage should be 2 after goal-complete, got ${prog.journeyStage}`);
      await page.screenshot({ path: SHOT('results', pass) });
    });

    await step('retry + plant a turnip + hint banner', async () => {
      await page.click('#btn-retry');
      await page.waitForFunction(() => !document.querySelector('#screens .screen.open'));
      await page.keyboard.press('1');
      await page.keyboard.press('ArrowRight'); // select plot 1
      await page.keyboard.press('Enter');      // plant turnip
      const planted = await page.evaluate(() =>
        window.MeadowRules.deserialize(JSON.parse(localStorage.getItem('meadowstead:snapshot')).state)
          .plots.some((p) => p.crop && p.crop.type === 'turnip'));
      if (!planted) throw new Error('turnip was not planted via UI');
      await page.keyboard.press('?');
      const hint = (await page.textContent('#hint-banner')).trim();
      if (!hint.startsWith('💡')) throw new Error('no hint shown: ' + hint);
      console.log(`  [${pass}] hint: ${hint}`);
    });

    await step('saved elapsed time survives reload', async () => {
      await page.evaluate(() => {
        const key = 'meadowstead:snapshot';
        const snap = JSON.parse(localStorage.getItem(key));
        snap.elapsedMs = 120000;
        localStorage.setItem(key, JSON.stringify(snap));
        // Load from a fresh page so beforeunload cannot overwrite the fixture.
      });
      const saved = await page.evaluate(() => localStorage.getItem('meadowstead:snapshot'));
      await page.goto('about:blank');
      await page.addInitScript(raw => localStorage.setItem('meadowstead:snapshot', raw), saved);
      await page.goto(BASE);
      await page.waitForSelector('#screen-away.open');
      await page.click('#btn-away-continue');
      await page.keyboard.press('Space'); // an actual command rewrites the restored snapshot
      await page.keyboard.press('p');
      const elapsed = await page.evaluate(() => JSON.parse(localStorage.getItem('meadowstead:snapshot')).elapsedMs);
      if (elapsed < 120000) throw new Error('resuming reset elapsed time');
      await page.click('#btn-resume');
    });

    await step('pause / resume', async () => {
      if (mobile) await page.keyboard.press('p');
      else await page.click('#btn-pause');
      await page.waitForSelector('#screen-pause.open');
      await page.screenshot({ path: SHOT('pause', pass) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => !document.querySelector('#screens .screen.open'));
    });

    await step('settings open, toggle reduced motion, close', async () => {
      await page.keyboard.press('p');
      await page.waitForSelector('#screen-pause.open');
      await page.click('#btn-settings-pause');
      await page.waitForSelector('#screen-settings.open');
      await page.locator('#settings-form label', { hasText: 'Reduced motion' }).locator('input').click();
      const applied = await page.evaluate(() => document.body.classList.contains('reduced-motion'));
      if (!applied) throw new Error('reduced-motion setting not applied');
      await page.screenshot({ path: SHOT('settings', pass) });
      await page.locator('#screen-settings [data-back]').click();
      await page.waitForSelector('#screen-pause.open');
      await page.click('#btn-resume');
      await page.waitForFunction(() => !document.querySelector('#screens .screen.open'));
    });

    await step('leave back to title', async () => {
      await page.keyboard.press('p');
      await page.waitForSelector('#screen-pause.open');
      await page.click('#btn-leave');
      await page.waitForSelector('#screen-title.open');
    });
  } finally {
    if (errors.length) {
      exitCode = 1;
      console.error(`PAGE ERRORS [${pass}]:\n` + errors.join('\n'));
    }
    await context.close();
    if (errors.length) throw new Error(`${errors.length} page error(s) during ${pass} pass`);
  }
}
