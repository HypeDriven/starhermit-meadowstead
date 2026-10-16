// StarHermit adapter (js/platform.js) over the real shared SDK with a stubbed
// fetch and launch fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlatform, mergeProgress } from '../js/platform.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'self', SDK_SRC)(mod, mod.exports, globalThis);
  return mod.exports;
}

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const FRIEND = 'f0000000-0000-4000-8000-000000000002';
const SLUG = 'meadowstead';

function fixture(href) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64url({ alg: 'none' })}.${b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const u = new URL(href.replace('{jwt}', jwt));
  const win = {
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, assign() {} },
    history: { state: null, replaceState(_s, _t, url) { win.replaced = url; } },
  };
  const calls = [];
  let slot = null;
  let version = 0; // the slot's ETag is "v<version>"; writes are conditional on it
  const kv = { muted: true };
  const res = (status, body, bytes) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers || {};
    calls.push({ url, method, body, auth: headers.Authorization, ifMatch: headers['If-Match'] });
    if (url === `/api/v1/users/${USER}/profile`) return res(200, { nickname: 'Farmer Fern', username: 'hidden' });
    if (url === `/api/v1/users/${FRIEND}/profile`) return res(200, { nickname: 'Neighbour Ned' });
    if (url === '/api/v1/me/friends') return res(200, [{ userId: FRIEND, username: 'ned_secret', online: true }]);
    if (url === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}/info`) {
      return res(200, slot ? { exists: true, etag: `"v${version}"` } : { exists: false });
    }
    if (url === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`) {
      if (method === 'PUT') {
        const want = slot ? `"v${version}"` : null;
        if ((headers['If-Match'] || null) !== want && !(headers['If-None-Match'] === '*' && !slot) && (headers['If-Match'] || headers['If-None-Match'])) {
          return res(412, { error: 'precondition failed', etag: want });
        }
        slot = new Uint8Array(Buffer.from(body.dataBase64, 'base64'));
        version++;
        return res(200, { etag: `"v${version}"` });
      }
      return slot ? res(200, null, slot) : res(404);
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(kv, body.settings);
      return res(200, { settings: kv });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) return res(200, { actions: [{ action: 'hint', codes: ['KeyQ'] }] });
    return res(404);
  };
  const setTimeout = (fn, ms) => { const t = globalThis.setTimeout(fn, ms); t.unref(); return t; };
  const sh = loadSdk().create({ window: win, fetch, setTimeout, clearTimeout });
  const mem = new Map();
  const store = { get: (k, f) => (mem.has(k) ? mem.get(k) : f), set: (k, v) => mem.set(k, v) };
  const state = { doc: null, applied: null, opts: null, identity: 0, merged: 0 };
  const p = createPlatform({
    sh, store,
    buildDoc: () => ({ schema: 1, savedAt: Date.now(), progress: state.doc }),
    applyDoc: (d, o) => { state.applied = d; state.opts = o; if (state.onApply) state.onApply(d); },
    onIdentity: () => { state.identity++; },
    onMerged: () => { state.merged++; },
  });
  // Another device writes the slot (bumps the version behind this client's back).
  const writeElsewhere = (doc) => {
    slot = new Uint8Array(zipStored(JSON.stringify(doc)));
    version++;
  };
  return { p, sh, win, calls, kv, state, writeElsewhere };
}
const tick = () => new Promise((r) => setImmediate(r));

test('hosted: token read + stripped, nickname, cloud save at game:<slug>', async () => {
  const { p, win, calls, state } = fixture('https://meadowstead.starhermit.com/#game_token={jwt}');
  await p.init();
  assert.equal(p.hosted, true);
  assert.equal(p.gameSlug, SLUG);
  assert.ok(!String(win.replaced).includes('game_token'));
  await tick(); await tick();
  assert.equal(p.displayName(), 'Farmer Fern');
  assert.ok(state.identity >= 1);
  assert.ok(calls.every((c) => /^Bearer /.test(c.auth)));
  assert.ok(!calls.some((c) => c.url.includes('/api/v1/time')));

  state.doc = { journeyStage: 7 };
  p.cloudSaveSoon();
  p.cloudFlush();
  await tick();
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/game%3Ameadowstead');
  await p.cloudLoad();
  // Our own save is merged (a no-op) but is not newer, so its settings are not taken.
  assert.deepEqual(state.applied.progress, { journeyStage: 7 });
  assert.equal(state.opts.newer, false);
  const fresh = fixture('https://meadowstead.starhermit.com/#game_token={jwt}');
  assert.equal(fresh.p.sync, 'offline');
});

test('hosted: settings KV patch, bindings, friends with nicknames, invite link', async () => {
  const { p, calls, kv } = fixture('https://x.example/#game_token={jwt}');
  await p.init();
  assert.deepEqual(await p.loadSettings(), { muted: true });
  p.primeSettings({ muted: true, haptics: true });
  p.pushSettings({ muted: true, haptics: false });
  await p.flushSettings();
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, `/api/v1/games/${SLUG}/settings`);
  assert.deepEqual(patch.body, { settings: { haptics: false } });
  assert.equal(kv.haptics, false);
  assert.deepEqual(await p.loadBindings({ hint: ['Slash'], wait: ['Space'] }), { hint: ['KeyQ'], wait: ['Space'] });
  assert.deepEqual(await p.friends(), [{ userId: FRIEND, name: 'Neighbour Ned', online: true }]);
  assert.equal(p.inviteLink(), `https://dashboard.starhermit.com/game-invite/${USER}/${SLUG}`);
});

test('standalone on the platform host: sign-in offered, zero fetches', async () => {
  const { p, calls } = fixture('https://0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com/');
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true);
  assert.deepEqual(await p.loadSettings(), {});
  assert.deepEqual(await p.loadBindings({ hint: ['Slash'] }), { hint: ['Slash'] });
  assert.deepEqual(await p.friends(), []);
  assert.deepEqual(await p.leaderboardEntries(false), []);
  p.cloudSaveSoon();
  p.cloudFlush();
  p.primeSettings({});
  p.pushSettings({ muted: false });
  assert.equal(p.inviteLink(), null);
  assert.equal(p.displayName(), 'You');
  assert.equal(calls.length, 0);
});

test('standalone on localhost: init makes zero requests, local clock', async () => {
  const { p, calls } = fixture('http://localhost:8080/index.html');
  const seen = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(String(url)); throw new Error('no network'); };
  try {
    await p.init();
    assert.equal(p.hosted, false);
    assert.ok(Math.abs(p.now() - Date.now()) < 1000);
    assert.equal(p.online, undefined);
    assert.equal(p.api, undefined);
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.deepEqual(seen, []);
  assert.equal(calls.length, 0);
});

test('save conflict: another device saved first → reload, merge, save the merge', async () => {
  const { p, sh, calls, state, writeElsewhere } = fixture('https://x.example/#game_token={jwt}');
  await p.init(); // empty slot: the first write must be If-None-Match: *
  await tick();
  state.doc = { journeyStage: 5, masteryXp: 300, achievements: { first_harvest: 10 } };
  p.cloudSaveSoon();
  p.cloudFlush();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(p.sync, 'synced');
  // Device B saves a further journey stage; our next write is refused (412).
  writeElsewhere({ schema: 1, savedAt: Date.now(), progress: { journeyStage: 9, masteryXp: 100, achievements: { first_order: 20 } } });
  let conflicts = 0;
  sh.on('saveconflict', () => { conflicts++; });
  state.onApply = (doc) => { state.doc = mergeProgress(state.doc, doc.progress); };
  state.doc = Object.assign({}, state.doc, { masteryXp: 350 });
  p.cloudSaveSoon();
  p.cloudFlush();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(conflicts, 1);
  assert.equal(state.merged, 1);
  assert.equal(state.opts.newer, false);
  assert.equal(state.doc.journeyStage, 9);
  assert.equal(state.doc.masteryXp, 350);
  assert.deepEqual(Object.keys(state.doc.achievements).sort(), ['first_harvest', 'first_order']);
  // The merge is saved again, conditional on the version just read.
  p.cloudFlush();
  for (let i = 0; i < 5; i++) await tick();
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.at(-1).ifMatch, '"v2"');
  assert.equal(p.sync, 'synced');
  assert.equal(sh.saveConflicted(), false);
});

test('mergeProgress keeps the best of both devices', () => {
  const local = { journeyStage: 4, masteryXp: 50, lifetimeCoins: 900, dailyStreak: 2, lastDailyDate: '2026-10-15',
    completedDailies: { '2026-10-15': 120 }, achievements: { a: 5 }, friends: ['Ann'], tutorialDone: false,
    localBoard: [{ name: 'Me', score: 100, mode: 'daily', seed: 's', when: 1 }] };
  const remote = { journeyStage: 6, masteryXp: 40, lifetimeCoins: 1200, dailyStreak: 3, lastDailyDate: '2026-10-16',
    completedDailies: { '2026-10-15': 140, '2026-10-16': 80 }, achievements: { a: 3, b: 7 }, friends: ['Bob', 'Ann'], tutorialDone: true,
    localBoard: [{ name: 'Me', score: 150, mode: 'daily', seed: 't', when: 2 }, { name: 'Me', score: 100, mode: 'daily', seed: 's', when: 1 }] };
  const m = mergeProgress(local, remote);
  assert.equal(m.journeyStage, 6);
  assert.equal(m.masteryXp, 50);
  assert.equal(m.lifetimeCoins, 1200);
  assert.equal(m.lastDailyDate, '2026-10-16');
  assert.equal(m.dailyStreak, 3);
  assert.deepEqual(m.completedDailies, { '2026-10-15': 140, '2026-10-16': 80 });
  assert.deepEqual(m.achievements, { a: 3, b: 7 });
  assert.deepEqual(m.friends.sort(), ['Ann', 'Bob']);
  assert.equal(m.tutorialDone, true);
  assert.deepEqual(m.localBoard.map((r) => r.score), [150, 100]);
});

/* A minimal stored (uncompressed) zip with one save.json entry, as the platform serves it. */
function zipStored(text) {
  const data = Buffer.from(text, 'utf8');
  const name = Buffer.from('save.json');
  let c = ~0;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  const crc = (~c) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const offCentral = local.length + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offCentral, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
