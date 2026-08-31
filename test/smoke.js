/* Browser smoke test: loads the game, starts a practice session, plays moves, screenshots. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#screen-title.open', { timeout: 10000 });
  console.log('title screen OK');

  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.open');
  await page.click('.mode[data-mode="practice"]');
  await page.waitForSelector('#screen-setup.open');
  await page.click('#btn-start-session');
  await page.waitForSelector('#screens .screen.open', { state: 'detached', timeout: 5000 }).catch(() => {});
  const hud = await page.textContent('#sb-tick');
  console.log('session started, HUD:', hud.trim());

  // plant via DOM mirror: tool 1 then plot 0
  await page.click('[data-crop="turnip"]');
  await page.click('#board-mirror button >> nth=0');
  await page.click('[data-tool="water"]');
  await page.click('#board-mirror button >> nth=0');
  const tick1 = await page.textContent('#sb-tick');
  console.log('after 2 actions:', tick1.trim());

  // wait until ready then harvest
  for (let i = 0; i < 4; i++) {
    await page.click('#board-mirror button >> nth=0'); // water if selected tool still water
    await page.keyboard.press(' ');
  }
  await page.keyboard.press('h');
  await page.click('#board-mirror button >> nth=0');
  const inv = await page.textContent('#inventory-list');
  console.log('inventory:', inv.trim());

  // hint + keyboard nav + pause/resume
  await page.keyboard.press('?');
  console.log('hint:', (await page.textContent('#hint-banner')).trim().slice(0, 60));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('p');
  await page.waitForSelector('#screen-pause.open');
  await page.click('#btn-resume');
  console.log('pause/resume OK');

  // settings
  await page.keyboard.press('p');
  await page.click('#btn-settings-pause');
  await page.waitForSelector('#screen-settings.open');
  console.log('settings controls:', await page.locator('#settings-form label').count());
  await page.click('#screen-settings [data-back]');
  await page.click('#btn-resume');

  // invalid action: harvest empty plot 3
  await page.keyboard.press('h');
  await page.click('#board-mirror button >> nth=3');
  console.log('invalid msg:', (await page.textContent('#live-errors')).trim());

  // grow a couple of crops for the visual capture
  await page.click('[data-crop="carrot"]');
  await page.click('#board-mirror button >> nth=1');
  await page.click('[data-crop="turnip"]');
  await page.click('#board-mirror button >> nth=4');
  await page.click('[data-tool="water"]');
  await page.click('#board-mirror button >> nth=1');
  await page.click('#board-mirror button >> nth=4');

  await page.screenshot({ path: 'smoke-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); // portrait mobile
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'smoke-mobile.png' });

  if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('SMOKE OK');
  await browser.close();
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
