// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): the Learn lesson from the title to
// its results, played by the rules bot (tools/gen-plays.mjs's) — on the desktop
// by the tool keys, arrows, Enter and Space with the Fulfill buttons clicked;
// on the phones by tapping the tool tray, the plot mirror and the Fulfill
// buttons in the left drawer. On the desktop then a Practice round: a click on
// a plot in the 3D field plants it, a mouse drag orbits the camera, C resets it,
// and the pause menu. Screenshots of each step go to --shots. Fails on console
// errors or warnings, the runtime's error screen, or a round that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);
const R = createRequire(import.meta.url)(join(dir, 'js/rules.js'));

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    for (const name of ['playwright-core', 'playwright']) {
      const p = join(r, 'node_modules', name);
      if (existsSync(p)) return createRequire(join(r, 'package.json'))(name);
    }
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's clock (platform.serverTime / serverNow), as the game host answers it.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// -- the Learn lesson by the rules bot -------------------------------------------------------------
const NAMES = { turnip: 'Turnip', carrot: 'Carrot', pumpkin: 'Pumpkin', salad: 'Garden Salad', pie: 'Harvest Pie' };
const TOOL_KEY = { turnip: 'Digit1', carrot: 'Digit2', pumpkin: 'Digit3', water: 'KeyW', harvest: 'KeyH' };
const TOOL_BTN = { turnip: '🌱 Turnip', carrot: '🥕 Carrot', pumpkin: '🎃 Pumpkin', water: '💧 Water', harvest: '🧺 Harvest' };
function pick(state) {
  const legal = R.legalActions(state);
  const unmet = {};
  for (const o of state.orders) for (const [k, n] of Object.entries(o.needs)) unmet[k] = Math.max(unmet[k] || 0, n - (state.inventory[k] || 0));
  return legal.find((a) => a.type === 'fulfill') || legal.find((a) => a.type === 'harvest') || legal.find((a) => a.type === 'water')
    || legal.find((a) => a.type === 'craft' && unmet[a.recipe] > 0)
    || legal.filter((a) => a.type === 'plant' && unmet[a.crop] > 0).sort((a, b) => unmet[b.crop] - unmet[a.crop])[0]
    || legal.find((a) => a.type === 'plant') || legal.find((a) => a.type === 'craft') || { type: 'wait' };
}
const learn = R.defaultConfig('learn', 'learn-seed', { maxTicks: 60, goalOrders: 2, plotCount: 8, allowedCrops: ['turnip', 'carrot'], allowedRecipes: [], difficulty: 'easy', assists: { hints: true, undo: true } });
function learnSteps(touch) {
  let state = R.createSession(learn);
  const out = [];
  let tool = null, sel = -1, id = 0;
  const n = state.plots.length;
  while (!state.terminalReason) {
    const a = pick(state);
    if (a.type === 'wait') out.push(touch ? ['role', '⏳ Wait'] : ['key', 'Space']);
    else if (a.type === 'fulfill') {
      const o = state.orders.find((x) => x.id === a.orderId);
      const name = `Fulfill order for ${Object.entries(o.needs).map(([k, c]) => `${c}× ${NAMES[k]}`).join(', ')}, reward ${o.reward} coins`;
      if (touch) out.push(['role', 'Open objective and orders panel'], ['wait', 600], ['role', name], ['wait', 600], ['role', 'Close panel']);
      else out.push(['role', name]);
    } else {
      const t = a.type === 'plant' ? a.crop : a.type;
      if (touch) {
        if (tool !== t) out.push(['role', TOOL_BTN[t]]);
        out.push(['plot', a.plot]);
      } else {
        if (tool !== t) out.push(['key', TOOL_KEY[t]]);
        if (sel < 0) { out.push(['key', 'ArrowRight']); sel = 1; }
        const fwd = (a.plot - sel + n) % n, back = (sel - a.plot + n) % n;
        for (let i = 0; i < Math.min(fwd, back); i++) out.push(['key', fwd <= back ? 'ArrowRight' : 'ArrowLeft']);
        sel = a.plot;
        out.push(['key', 'Enter']);
      }
      tool = t;
    }
    out.push(['wait', 250]);
    state = R.apply(state, { id: 'b' + (id++), type: a.type, plot: a.plot, crop: a.crop, recipe: a.recipe, orderId: a.orderId }).state;
  }
  return out;
}
const lesson = (touch) => [
  ['shot', 'title'], ['role', '▶ Play'], ['wait', 1200], ['shot', 'modes'], ['role', 'Learn'], ['wait', 1200], ['shot', 'setup'],
  ['role', 'Start'], ['wait', 2500], ['shot', 'play'], ['expect', 'Step 1/5'],
  ...learnSteps(touch), ['wait', 2500], ['shot', 'results'], ['expect', 'Homestead goal complete'],
];
const desktopExtra = [
  ['role', 'Home'], ['wait', 1200], ['role', '▶ Play'], ['wait', 1000], ['role', 'Practice'], ['wait', 1000], ['role', 'Start'], ['wait', 2500],
  ['key', 'Digit1'], ['wait', 300], ['field', 5], ['wait', 1500], ['expect', 'Time 1/'], ['shot', 'field-click'],
  ['drag', 0.25], ['wait', 800], ['shot', 'orbit'], ['key', 'KeyC'], ['wait', 500],
  ['key', 'KeyP'], ['wait', 800], ['shot', 'paused'], ['expect', 'Paused'],
];
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 }, steps: [...lesson(false), ...desktopExtra] },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: lesson(true) },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: lesson(true) },
];

/** A plot's window point in the playfield (native/render.ts camera: fov 38 widened under a 0.85 aspect, the
 * authored position and target; the 12-plot field). */
function plotPoint(rect, index, count = 12) {
  const col = index % 4, row = Math.floor(index / 4), rows = Math.ceil(count / 4);
  const p = [(col - 1.5) * 2.2, 0.3, (row - (rows - 1) / 2) * 2.2];
  const pos = [0, 12.5, 15], look = [0, 0, -0.5];
  const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(look, pos)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const aspect = rect.width / rect.height;
  const fov = aspect >= 0.85 ? 38 : 2 * Math.atan(Math.tan(19 * Math.PI / 180) * 0.85 / aspect) * 180 / Math.PI;
  const t = Math.tan(fov * Math.PI / 360);
  const d = sub(p, pos), z = dot(d, f);
  const nx = dot(d, r) / (z * t * aspect), ny = dot(d, u) / (z * t);
  return { x: rect.x + (nx + 1) / 2 * rect.width, y: rect.y + (1 - ny) / 2 * rect.height };
}

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000); // the first press can be lost while the runtime starts up
  const press = async (loc) => (v.hasTouch ? loc.tap({ timeout: 10000 }) : loc.click({ timeout: 10000 }));
  for (const [op, a] of v.steps) {
    try {
      if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(80); await page.keyboard.up(a); await page.waitForTimeout(80); }
      if (op === 'wait') await page.waitForTimeout(a);
      if (op === 'role') await press(page.getByRole('button', { name: a, exact: true }));
      if (op === 'plot') await press(page.getByRole('button', { name: new RegExp(`^(Empty plot ${a + 1}|Plot ${a + 1}:)`) }).first());
      if (op === 'field' || op === 'drag') {
        const box = await page.getByText('Meadowstead playfield').first().boundingBox({ timeout: 5000 }).catch(() => null)
          ?? await page.getByLabel('Meadowstead playfield').first().boundingBox({ timeout: 5000 }).catch(() => null);
        if (!box) { problems.push(`${op}: playfield not found`); continue; }
        if (op === 'field') { const pt = plotPoint(box, a); await page.mouse.click(pt.x, pt.y); }
        else {
          const y = box.y + box.height * 0.3, x0 = box.x + box.width * 0.5;
          await page.mouse.move(x0, y); await page.mouse.down(); await page.waitForTimeout(200);
          for (let i = 1; i <= 10; i++) { await page.mouse.move(x0 + box.width * a * i / 10, y); await page.waitForTimeout(30); }
          await page.mouse.up();
        }
      }
      if (op === 'expect' && !(await page.getByText(a).count().catch(() => 0)) && !(await page.getByRole('heading', { name: a }).count().catch(() => 0))) problems.push(`expected "${a}" on screen`);
      if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
    } catch (e) { problems.push(`${op} ${typeof a === 'string' ? a : JSON.stringify(a)}: ${e.message.split('\n')[0]}`); }
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
