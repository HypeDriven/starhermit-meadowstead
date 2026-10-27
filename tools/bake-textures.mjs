// Bakes the browser build's procedural canvas textures (js/render.js before the
// engine port: makeGrassTexture, makeRippleNormalMap) into assets/textures/ by
// running that canvas code unchanged in Chrome (~/games/tools/gpu-chrome.mjs).
// The meadow's 350 radial mottles and 2,600 blade strokes and the ripple map's
// per-pixel waves paint far too slowly on the engine's canvas at start-up, so
// the engine client loads these images instead (native/render.ts), one per
// preset texture budget (js/gfx.js BUDGETS: Low 128, Balanced 256, High 512,
// Ultra 1024; the ripple map is half of it):
//   grass-<px>.png   near-white meadow luminance tile (sRGB colour map)
//   ripple-<px>.png  pond ripple normal map
// Run once; commit the PNGs.   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    for (const name of ['playwright-core', 'playwright']) {
      const p = join(r, 'node_modules', name);
      if (existsSync(p)) return createRequire(join(r, 'package.json'))(name);
    }
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The old js/render.js painters, verbatim but returning canvases.
const painters = String.raw`
function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}
function makeGrassTexture(size) {
  const [c, g] = canvas2d(size || 256);
  g.scale((size || 256) / 256, (size || 256) / 256);
  g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = 14 + rnd() * 34, v = 200 + Math.floor(rnd() * 55);
    for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grd.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.45)');
      grd.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
      g.fillStyle = grd; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 256, y = rnd() * 256, v = (rnd() < 0.5 ? 170 + rnd() * 40 : 240 + rnd() * 15) | 0;
    g.strokeStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.55)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4); g.stroke();
  }
  return c;
}
function makeRippleNormalMap(size) {
  const N = Math.max(32, Math.round(size || 128));
  const [c, g] = canvas2d(N);
  const img = g.createImageData(N, N);
  const h = (x, y) => {
    const u = (x / N) * Math.PI * 2, v = (y / N) * Math.PI * 2;
    return Math.sin(u * 3 + v * 2) * 0.5 + Math.sin(u * -2 + v * 5 + 1.3) * 0.35 + Math.sin(u * 7 - v * 3 + 0.4) * 0.15;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
    const nx = -dx * 2, ny = -dy * 2, nz = 1, l = Math.hypot(nx, ny, nz);
    const o = (y * N + x) * 4;
    img.data[o] = (nx / l * 0.5 + 0.5) * 255;
    img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
    img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}`;

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ content: painters });
  const jobs = [];
  for (const px of [256, 512, 1024]) jobs.push([`grass-${px}.png`, `makeGrassTexture(${px})`]);
  for (const px of [128, 256, 512]) jobs.push([`ripple-${px}.png`, `makeRippleNormalMap(${px})`]);
  for (const [name, expr] of jobs) {
    const url = await page.evaluate((e) => (0, eval)(e).toDataURL('image/png'), expr);
    writeFileSync(join(root, 'assets/textures', name), Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote assets/textures/' + name);
  }
} finally { await close(); }
