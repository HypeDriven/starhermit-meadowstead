/* Meadowstead — authoritative server.
   Static hosting + same-origin /api routes: platform time, daily seed,
   replay-validated score submission, leaderboards, idempotent achievements.
   Zero dependencies (Node stdlib only). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./js/rules.js');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8080;
const BUILD_VERSION = '1.0.0';

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
function saveJSON(name, obj) {
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

let leaderboard = loadJSON('leaderboard.json', { global: [], daily: {} });
let achievements = loadJSON('achievements.json', {}); // sessionId -> {key: ts}
let excludedDays = loadJSON('excluded-days.json', []); // defective dailies excluded from ranking

/* ---------- replay validation (authoritative) ---------- */
function validateScoreSubmission(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'malformed' };
  if (env.schemaVersion !== R.SCHEMA_VERSION) return { ok: false, error: 'stale-schema-version' };
  if (env.contentVersion !== R.CONTENT_VERSION) return { ok: false, error: 'stale-content-version' };
  if (!Array.isArray(env.commands) || env.commands.length > 20000) return { ok: false, error: 'bad-command-log' };
  if (JSON.stringify(env).length > 500000) return { ok: false, error: 'payload-too-large' };
  const cfg = R.defaultConfig(env.config && env.config.mode, env.config && env.config.seed, env.config || {});
  // Reject tampered daily seeds: daily config seed must match the server's UTC day seeds.
  if (cfg.mode === 'daily') {
    const claimed = String(cfg.seed);
    const m = /^daily-(\d{4}-\d{2}-\d{2})-/.exec(claimed);
    if (!m || R.dailySeed(m[1]) !== claimed) return { ok: false, error: 'bad-daily-seed' };
    if (excludedDays.includes(m[1])) return { ok: false, error: 'day-excluded-from-ranking' };
  }
  // Authoritative replay of the ordered input log.
  let state = R.createSession(cfg);
  const initialHash = R.stateHash(state);
  if (env.initialHash !== initialHash) return { ok: false, error: 'initial-hash-mismatch' };
  const seen = new Set();
  for (const cmd of env.commands) {
    if (!cmd || typeof cmd.id !== 'string' || cmd.id.length > 64) return { ok: false, error: 'bad-command' };
    if (seen.has(cmd.id)) return { ok: false, error: 'duplicate-command' };
    seen.add(cmd.id);
    const res = R.apply(state, cmd);
    state = res.state;
  }
  const finalHash = R.stateHash(state);
  if (finalHash !== env.finalHash) return { ok: false, error: 'final-hash-mismatch' };
  if (!state.score || !env.score || state.score.total !== env.score.total) return { ok: false, error: 'score-mismatch' };
  if (!state.terminalReason) return { ok: false, error: 'session-not-terminal' };
  return { ok: true, state };
}

/* Tie-break order: goal completion, fewer invalid actions, lower elapsed, stable session id. */
function compareRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if ((b.goalComplete ? 1 : 0) !== (a.goalComplete ? 1 : 0)) return (b.goalComplete ? 1 : 0) - (a.goalComplete ? 1 : 0);
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

/* ---------- rate limiting ---------- */
const buckets = new Map();
function rateLimited(ip, perMinute) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, reset: now + 60000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 60000; }
  b.count++;
  buckets.set(ip, b);
  return b.count > perMinute;
}

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.opus': 'audio/ogg; codecs=opus',
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // immutable caching for hashed/module assets
    if (rel.includes('node_modules') || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* ---------- API ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const ip = req.socket.remoteAddress || 'unknown';

  if (url.startsWith('/api/v1/')) {
    const route = url.slice('/api/v1'.length).split('?')[0];
    try {
      if (route === '/time' && req.method === 'GET') {
        return sendJSON(res, 200, { now: Date.now(), build: BUILD_VERSION });
      }
      if (route === '/daily' && req.method === 'GET') {
        const date = new Date().toISOString().slice(0, 10);
        return sendJSON(res, 200, {
          date, seed: R.dailySeed(date), contentVersion: R.CONTENT_VERSION,
          excluded: excludedDays.includes(date),
        });
      }
      if (route === '/scores' && req.method === 'POST') {
        if (rateLimited(ip + ':scores', 20)) return sendJSON(res, 429, { error: 'rate-limited' });
        const env = JSON.parse(await readBody(req, 600000));
        const v = validateScoreSubmission(env);
        if (!v.ok) return sendJSON(res, 200, { accepted: false, error: v.error });
        const st = v.state;
        const row = {
          name: (env.playerName || 'Player').slice(0, 24),
          score: st.score.total,
          goalComplete: st.terminalReason === 'goal-complete',
          invalidActions: st.invalidActions,
          elapsedMs: Math.max(0, env.elapsedMs | 0),
          sessionId: String(env.sessionId || 'anon').slice(0, 32),
          seed: st.seed, ruleset: env.mode, contentVersion: st.contentVersion,
          assists: env.config && env.config.assists ? env.config.assists : {},
          when: Date.now(),
        };
        if (env.mode === 'daily') {
          const date = new Date().toISOString().slice(0, 10);
          (leaderboard.daily[date] = leaderboard.daily[date] || []).push(row);
          leaderboard.daily[date].sort(compareRows);
          leaderboard.daily[date] = leaderboard.daily[date].slice(0, 100);
        } else {
          leaderboard.global.push(row);
          leaderboard.global.sort(compareRows);
          leaderboard.global = leaderboard.global.slice(0, 100);
        }
        saveJSON('leaderboard.json', leaderboard);
        return sendJSON(res, 200, { accepted: true, score: st.score.total });
      }
      if (route === '/leaderboard' && req.method === 'GET') {
        const q = new URL(url, 'http://x').searchParams;
        const board = q.get('board') || 'global';
        let rows;
        if (board === 'daily') {
          const date = q.get('date') || new Date().toISOString().slice(0, 10);
          rows = leaderboard.daily[date] || [];
        } else rows = leaderboard.global;
        return sendJSON(res, 200, { rows: rows.slice(0, 50), validated: true });
      }
      if (route === '/achievements' && req.method === 'POST') {
        if (rateLimited(ip + ':ach', 60)) return sendJSON(res, 429, { error: 'rate-limited' });
        const body = JSON.parse(await readBody(req, 4096));
        const key = String(body.key || '');
        if (!/^[a-z0-9_]{1,40}$/.test(key)) return sendJSON(res, 400, { error: 'bad-key' });
        const sid = String(body.sessionId || ip).slice(0, 40);
        achievements[sid] = achievements[sid] || {};
        if (!achievements[sid][key]) { // idempotent unlock
          achievements[sid][key] = Date.now();
          saveJSON('achievements.json', achievements);
        }
        return sendJSON(res, 200, { unlocked: true });
      }
      if (route === '/telemetry' && req.method === 'POST') {
        if (rateLimited(ip + ':tel', 120)) return sendJSON(res, 429, { error: 'rate-limited' });
        await readBody(req, 8192); // aggregate-only funnel events; not persisted with identity
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 404, { error: 'unknown-route' });
    } catch (e) {
      const msg = e && e.message === 'payload-too-large' ? 'payload-too-large' : 'server-error';
      return sendJSON(res, msg === 'payload-too-large' ? 413 : 500, { error: msg });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'method-not-allowed' });
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('Meadowstead server on http://localhost:' + PORT);
});
