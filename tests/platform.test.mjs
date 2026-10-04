// StarHermit adapter (js/platform.js) over the real shared SDK with a stubbed
// fetch and launch fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlatform } from '../js/platform.js';

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
  const kv = { muted: true };
  const res = (status, body, bytes) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, auth: (init.headers || {}).Authorization });
    if (url === `/api/v1/users/${USER}/profile`) return res(200, { nickname: 'Farmer Fern', username: 'hidden' });
    if (url === `/api/v1/users/${FRIEND}/profile`) return res(200, { nickname: 'Neighbour Ned' });
    if (url === '/api/v1/me/friends') return res(200, [{ userId: FRIEND, username: 'ned_secret', online: true }]);
    if (url === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`) {
      if (method === 'PUT') { slot = new Uint8Array(Buffer.from(body.dataBase64, 'base64')); return res(204); }
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
  const state = { doc: null, applied: null, identity: 0 };
  const p = createPlatform({
    sh, store,
    buildDoc: () => ({ schema: 1, savedAt: Date.now(), progress: state.doc }),
    applyDoc: (d) => { state.applied = d; },
    onIdentity: () => { state.identity++; },
  });
  return { p, win, calls, kv, state };
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
  assert.equal(state.applied, null); // our own save: not newer than the local copy
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
  const { p, calls } = fixture('https://meadowstead.starhermit.com/');
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
