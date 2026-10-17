// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and keeps farming through the game's own controls (crop keys / W / H, arrow keys
// to pick a plot, Enter to act, Space to wait; Fulfill buttons in the orders rail) — plant bursts, crop
// growth tweens, wind, pond ripples and pollen motes run all the time. Retry starts a new run from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.open', { timeout: 20000 });
  await page.click('#btn-settings-title');
  await page.waitForSelector('#screen-settings.open #gfx-section');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('gl').dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings [data-back]').click();
  await page.waitForSelector('#screen-title.open');
}

// Greedy next action from the snapshot the game persists after every move (same bot as tests/e2e.mjs).
const nextAction = (page) => page.evaluate(() => {
  const R = window.MeadowRules;
  const raw = localStorage.getItem('meadowstead:snapshot');
  if (!raw) return { done: true };
  const st = R.deserialize(JSON.parse(raw).state);
  if (st.terminalReason) return { done: true };
  const legal = R.legalActions(st);
  const pick = legal.find((a) => a.type === 'fulfill') || legal.find((a) => a.type === 'harvest') || legal.find((a) => a.type === 'water') ||
    legal.find((a) => a.type === 'plant') || { type: 'wait' };
  const cur = [...document.querySelectorAll('#board-mirror button')].findIndex((b) => b.classList.contains('selected'));
  return { done: false, action: pick, cur, total: st.plots.length };
});

const CROP_KEY = { turnip: '1', carrot: '2', pumpkin: '3' };

async function step(page) {
  if (await page.locator('#screen-results.open').count()) {
    await page.click('#btn-retry');
    await page.waitForFunction(() => !document.querySelector('#screens .screen.open'), null, { timeout: 5000 });
    return;
  }
  const d = await nextAction(page);
  if (d.done) return;
  const a = d.action;
  if (a.type === 'wait') return page.keyboard.press(' ');
  if (a.type === 'fulfill') {
    // Orders sit in the left rail (a drawer on phones): open it, press Fulfill, close it again.
    const drawer = await page.locator('#btn-drawer-left').isVisible();
    if (drawer && !(await page.locator('#rail-left.open').count())) await page.click('#btn-drawer-left');
    await page.locator('#orders-list li.fulfillable button').first().click({ timeout: 3000 });
    if (drawer && (await page.locator('#rail-left.open').count())) await page.click('#btn-drawer-left');
    return;
  }
  await page.keyboard.press(a.type === 'plant' ? CROP_KEY[a.crop] : a.type === 'water' ? 'w' : 'h');
  let cur = d.cur;
  if (cur < 0) { await page.keyboard.press('ArrowLeft'); cur = d.total - 1; }
  let steps = (a.plot - cur + d.total) % d.total;
  while (steps-- > 0) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
}

export async function start(page) {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-setup.open');
  await page.click('#btn-start-session');
  await page.waitForFunction(() => !document.querySelector('#screens .screen.open'), null, { timeout: 10000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(350).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
