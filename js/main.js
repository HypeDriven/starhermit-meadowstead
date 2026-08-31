/* Meadowstead — bootstrap, session, UI, input, persistence, platform adapter. */
import * as THREE from '../node_modules/three/build/three.module.js';

const R = window.MeadowRules;
const Audio = window.MeadowAudio;
const Render = window.MeadowRender;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

/* ================= persistence ================= */
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('meadowstead:' + k); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('meadowstead:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('meadowstead:' + k); } catch {} },
};

const DEFAULT_SETTINGS = {
  volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 },
  muted: false,
  quality: 'medium',
  reducedMotion: false,
  highContrast: false,
  palette: 'default',
  textScale: 1,
  leftHanded: false,
  holdToConfirm: false,
  timingAssist: false,
  haptics: true,
  captions: true,
  tutorialDone: false,
  cameraShake: true,
};
let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
settings.volumes = Object.assign({}, DEFAULT_SETTINGS.volumes, settings.volumes || {});

let progress = store.get('progress', {
  schema: 1, journeyStage: 1, masteryXp: 0, lifetimeCoins: 0,
  achievements: {}, dailyStreak: 0, lastDailyDate: null, completedDailies: {},
  tutorialDone: false, friends: [], localBoard: [],
});

/* ================= platform adapter ================= */
const platform = {
  online: false,
  timeOffset: 0,
  token: null, // launch token read from URL, never persisted
  async init() {
    const params = new URLSearchParams(location.search);
    this.token = params.get('launchToken') || null; // scope from host, not hard-coded
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error('time-' + res.status);
      const body = await res.json();
      this.timeOffset = body.now - (t0 + Date.now()) / 2; // round-trip adjusted
      this.online = true;
    } catch { this.online = false; this.timeOffset = 0; }
  },
  now() { return Date.now() + this.timeOffset; },
  utcDate() { return new Date(this.now()).toISOString().slice(0, 10); },
  async api(path, opts) {
    const res = await fetch('/api/v1' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts));
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
    if (!res.ok) throw Object.assign(new Error(body.error || ('http-' + res.status)), { code: body.error });
    return body;
  },
};

/* ================= analytics (anonymous funnel, aggregate only) ================= */
const analytics = {
  sessionId: 's-' + Math.random().toString(36).slice(2, 10),
  log(event, data) {
    const line = { t: Date.now(), event, data: data || {} };
    const buf = store.get('funnel', []);
    buf.push(line);
    store.set('funnel', buf.slice(-200));
    if (platform.online) {
      platform.api('/telemetry', { method: 'POST', body: JSON.stringify(line) }).catch(() => {});
    }
  },
};

/* ================= achievements ================= */
const ACHIEVEMENTS = [
  { key: 'first_harvest', name: 'First Harvest', desc: 'Harvest your first crop.' },
  { key: 'first_order', name: 'Order Up', desc: 'Fulfill your first order.' },
  { key: 'crafter', name: 'Homestead Kitchen', desc: 'Craft 10 goods in total.' },
  { key: 'journey_10', name: 'Seasoned Hand', desc: 'Complete journey stage 10.' },
  { key: 'daily_streak_3', name: 'Three Dawns', desc: 'Complete the daily challenge 3 days in a row.' },
  { key: 'homestead_restored', name: 'Homestead Restored', desc: 'Earn 5000 lifetime coins.' },
];
function unlockAchievement(key) {
  if (progress.achievements[key]) return false; // idempotent
  progress.achievements[key] = Date.now();
  saveProgress();
  announce('Achievement unlocked: ' + (ACHIEVEMENTS.find(a => a.key === key) || {}).name);
  const el = $('achievements-earned');
  if (el) el.textContent = '🏅 ' + (ACHIEVEMENTS.find(a => a.key === key) || {}).name;
  if (platform.online) platform.api('/achievements', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => {});
  return true;
}
function saveProgress() { store.set('progress', progress); }

/* ================= session ================= */
const session = {
  state: null,
  config: null,
  undoStack: [],
  log: [],       // ordered commands for replay
  startedAt: 0,
  ranked: false,
  tutorialStep: -1,
  cmdSerial: 0,
  savedSnapshot: null,

  start(config) {
    this.config = config;
    this.state = R.createSession(config);
    this.undoStack = [];
    this.log = [];
    this.startedAt = Date.now();
    this.cmdSerial = 0;
    this.ranked = config.mode === 'daily' || config.mode === 'score';
    if (renderer) { Audio.setSeed(config.seed); Render.setDecorationSeed(renderer, config.seed); }
    else Audio.setSeed(config.seed);
    hideScreens();
    screenStack = [];
    setStatus('playing');
    announce('Session started. ' + objectiveText());
    analytics.log('start', { mode: config.mode, seed: config.seed });
    if (config.mode === 'learn') startTutorial();
    refreshAll();
    saveSnapshot();
  },

  command(cmd) {
    if (!this.state) return { ok: false, reason: 'no-session' };
    cmd.id = 'c' + (++this.cmdSerial) + '-' + this.startedAt.toString(36);
    const undoable = this.config.assists && this.config.assists.undo;
    const res = R.apply(this.state, cmd);
    if (!res.ok) {
      this.state = res.state; // invalid-action counter advances
      Audio.sfx.invalid();
      showError(cmd, res.reason);
      refreshAll();
      return res;
    }
    if (undoable) this.undoStack.push(R.serialize(this.state));
    this.state = res.state;
    this.log.push(cmd);
    for (const ev of res.events) this.handleEvent(ev);
    if (this.tutorialStep >= 0) tutorialOnCommand(cmd);
    refreshAll();
    saveSnapshot();
    if (this.state.terminalReason) this.finish();
    return res;
  },

  undo() {
    if (!this.config || !(this.config.assists || {}).undo) { showError(null, 'undo-not-allowed'); return; }
    const snap = this.undoStack.pop();
    if (!snap) { showError(null, 'nothing-to-undo'); return; }
    this.state = R.deserialize(snap);
    this.log.pop();
    Audio.sfx.click();
    announce('Undone. Back to time ' + this.state.tick + '.');
    refreshAll();
  },

  handleEvent(ev) {
    switch (ev.type) {
      case 'planted': Audio.sfx.plant(); if (renderer) Render.burst(renderer, ev.plot, 0x63b34d, 8); break;
      case 'watered': Audio.sfx.water(); if (renderer) Render.burst(renderer, ev.plot, 0x5fa8e0, 8); break;
      case 'harvested':
        Audio.sfx.harvest(); if (renderer) Render.burst(renderer, ev.plot, 0xffe066, 12);
        unlockAchievement('first_harvest'); break;
      case 'crafted': Audio.sfx.craft(); progress.craftTotal = (progress.craftTotal || 0) + 1;
        if (progress.craftTotal >= 10) unlockAchievement('crafter');
        saveProgress(); break;
      case 'fulfilled':
        Audio.sfx.fulfill(); unlockAchievement('first_order');
        progress.lifetimeCoins += ev.reward;
        if (progress.lifetimeCoins >= 5000) unlockAchievement('homestead_restored');
        saveProgress(); break;
      case 'grown': Audio.sfx.grown(); break;
      case 'withered': Audio.sfx.wither(); break;
      case 'terminal': Audio.sfx.terminal(); break;
    }
  },

  async finish() {
    const st = this.state;
    analytics.log('round_end', { mode: st.mode, score: st.score.total, reason: st.terminalReason });
    // Journey progression
    if (st.mode === 'journey' && st.terminalReason === 'goal-complete') {
      if (st.configRef && st.configRef.stage === progress.journeyStage && progress.journeyStage < 40) {
        progress.journeyStage++;
        if (progress.journeyStage > 10) unlockAchievement('journey_10');
      }
      progress.masteryXp += st.score.total;
      saveProgress();
    }
    // Daily streak
    if (st.mode === 'daily' && st.terminalReason === 'goal-complete') {
      const today = platform.utcDate();
      const yesterday = new Date(platform.now() - 86400000).toISOString().slice(0, 10);
      progress.dailyStreak = (progress.lastDailyDate === yesterday) ? progress.dailyStreak + 1 : 1;
      progress.lastDailyDate = today;
      progress.completedDailies[today] = st.score.total;
      if (progress.dailyStreak >= 3) unlockAchievement('daily_streak_3');
      saveProgress();
    }
    // Score submission with replay envelope
    let submissionNote = '';
    const envelope = {
      schemaVersion: R.SCHEMA_VERSION,
      contentVersion: st.contentVersion,
      build: BUILD_VERSION,
      mode: st.mode,
      seed: st.seed,
      config: this.config,
      commands: this.log,
      initialHash: R.stateHash(R.createSession(this.config)),
      finalHash: R.stateHash(st),
      terminalReason: st.terminalReason,
      score: st.score,
      invalidActions: st.invalidActions,
      elapsedMs: Date.now() - this.startedAt,
      sessionId: analytics.sessionId,
    };
    if (this.ranked) {
      if (platform.online) {
        try {
          const res = await platform.api('/scores', { method: 'POST', body: JSON.stringify(envelope) });
          submissionNote = res.accepted ? 'Score validated and submitted to the ranked board.' : 'Score rejected: ' + (res.error || 'validation failed');
        } catch (e) {
          submissionNote = 'Score saved locally (server unavailable: ' + e.message + ').';
          submitLocal(envelope);
        }
      } else {
        submissionNote = 'Offline: score recorded on the local casual board.';
        submitLocal(envelope);
      }
    }
    store.del('snapshot');
    showResults(envelope, submissionNote);
  },

  snapshotSave() {
    if (!this.state || this.state.terminalReason) return;
    store.set('snapshot', {
      schema: 1, savedAt: Date.now(), config: this.config, log: this.log,
      state: R.serialize(this.state), ranked: this.ranked,
    });
  },
};

function submitLocal(envelope) {
  // casual local board with plausibility check
  const replay = replayEnvelope(envelope);
  if (!replay.ok) return;
  progress.localBoard.push({
    name: 'You', score: replay.score.total, mode: envelope.mode,
    seed: envelope.seed, when: Date.now(), board: envelope.mode === 'daily' ? 'daily' : 'global',
  });
  progress.localBoard.sort((a, b) => b.score - a.score);
  progress.localBoard = progress.localBoard.slice(0, 50);
  saveProgress();
}

/* Replay validation shared with server semantics. */
function replayEnvelope(envelope) {
  try {
    let st = R.createSession(envelope.config);
    for (const cmd of envelope.commands) {
      const res = R.apply(st, cmd);
      st = res.state;
    }
    const hash = R.stateHash(st);
    if (hash !== envelope.finalHash) return { ok: false, error: 'hash-mismatch' };
    return { ok: true, score: st.score, state: st };
  } catch (e) {
    return { ok: false, error: 'replay-error' };
  }
}

function saveSnapshot() { session.snapshotSave(); }

/* ================= tutorial (Learn mode) ================= */
const TUTORIAL_STEPS = [
  { text: 'Welcome! Select the Turnip tool (key 1), then choose an empty plot to plant.', match: c => c.type === 'plant' },
  { text: 'Good. Now water your crop with the Water tool (key W) on the planted plot.', match: c => c.type === 'water' },
  { text: 'Crops grow one step each time you act, but only when watered. Keep watering until it is ready.', match: c => c.type === 'harvest' },
  { text: 'Harvested! Check the orders on the left — grow what they ask for, then fulfill an order.', match: c => c.type === 'fulfill' },
  { text: 'Orders pay coins and score. Crafting combines crops into valuable goods. Fulfill 2 orders to finish this lesson.', match: null },
];
function startTutorial() {
  session.tutorialStep = 0;
  showTutorialStep();
}
function showTutorialStep() {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  const bubble = $('tutorial-bubble');
  if (!step) { bubble.hidden = true; session.tutorialStep = -1; return; }
  $('tutorial-text').textContent = 'Step ' + (session.tutorialStep + 1) + '/' + TUTORIAL_STEPS.length + ': ' + step.text;
  bubble.hidden = false;
  announce(step.text);
  analytics.log('tutorial_step', { step: session.tutorialStep });
}
function tutorialOnCommand(cmd) {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  if (!step) return;
  if (step.match && step.match(cmd)) {
    session.tutorialStep++;
    showTutorialStep();
  } else if (!step.match && session.state.ordersFulfilled >= 2) {
    session.tutorialStep++;
    showTutorialStep();
    if (session.tutorialStep >= TUTORIAL_STEPS.length) {
      progress.tutorialDone = true; settings.tutorialDone = true; saveSettings(); saveProgress();
    }
  }
}

/* ================= UI helpers ================= */
let currentTool = null; // {type:'plant',crop} | {type:'water'} | {type:'harvest'}
let selectedPlot = -1;

function announce(msg) { $('live-objective').textContent = msg; }
function announceScore(msg) { $('live-score').textContent = msg; }
function showError(cmd, reason) {
  const text = ERROR_TEXT[reason] || ('Cannot do that: ' + reason);
  $('live-errors').textContent = text;
  $('hint-banner').textContent = '⚠ ' + text;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { $('hint-banner').textContent = ''; }, 3000);
}
const ERROR_TEXT = {
  'wrong-season': 'That crop does not grow in this season.',
  'plot-occupied': 'That plot already has a crop.',
  'no-crop': 'There is no crop on that plot.',
  'already-watered': 'That crop is already watered.',
  'already-grown': 'That crop is ready — harvest it instead.',
  'not-ready': 'That crop is not ready yet. Keep watering it.',
  'missing-ingredients': 'You do not have the ingredients for that recipe.',
  'missing-items': 'You do not have the items that order needs.',
  'no-such-order': 'That order is no longer available.',
  'crop-not-unlocked': 'That crop is not available in this session.',
  'recipe-not-unlocked': 'That recipe is not available in this session.',
  'session-over': 'This session has ended.',
  'duplicate-command': 'That action was already applied.',
  'undo-not-allowed': 'Undo is only available in Practice mode.',
  'nothing-to-undo': 'Nothing to undo.',
};

function objectiveText() {
  const st = session.state;
  if (!st) return '';
  return `Fulfill ${st.goalOrders} orders before time runs out (${st.ordersFulfilled}/${st.goalOrders}).`;
}

function setStatus(s) { $('app').dataset.screen = s; }

function hideScreens() {
  document.querySelectorAll('#screens .screen.open').forEach(el => el.classList.remove('open'));
}
let screenStack = [];
function showScreen(id) {
  hideScreens();
  const el = $(id);
  el.classList.add('open');
  screenStack.push(id);
  const first = el.querySelector('button, input, [tabindex]');
  if (first) first.focus();
  setStatus('screen');
}
function backScreen() {
  hideScreens();
  screenStack.pop(); // current
  const prev = screenStack[screenStack.length - 1];
  if (prev) {
    $(prev).classList.add('open');
    const first = $(prev).querySelector('button, input, [tabindex]');
    if (first) first.focus();
  } else if (session.state && !session.state.terminalReason) setStatus('playing');
  else showScreen('screen-title');
}

/* ================= refresh UI ================= */
function refreshAll() {
  const st = session.state;
  if (!st) return;
  const season = R.seasonAt(st.tick);
  $('sb-season').textContent = season[0].toUpperCase() + season.slice(1);
  $('sb-tick').textContent = `Time ${st.tick}/${st.maxTicks}`;
  $('sb-coins').textContent = '🪙 ' + st.coins;
  const scoreSoFar = R.computeScore(Object.assign({}, st, { terminalReason: st.terminalReason || 'x' }));
  $('sb-score').textContent = 'Score ' + (st.score ? st.score.total : scoreSoFar.total - scoreSoFar.timeBonus);
  $('sb-mode').textContent = st.mode[0].toUpperCase() + st.mode.slice(1);
  $('objective-text').textContent = objectiveText();
  $('objective-progress').value = Math.round(100 * st.ordersFulfilled / st.goalOrders);

  // orders
  const ol = $('orders-list');
  ol.innerHTML = '';
  for (const o of st.orders) {
    const li = document.createElement('li');
    const needs = Object.entries(o.needs).map(([k, n]) => `${n}× ${itemName(k)}`).join(', ');
    const can = R.check(st, { type: 'fulfill', orderId: o.id }).ok;
    li.className = can ? 'fulfillable' : '';
    const label = document.createElement('span');
    label.textContent = `${needs} → 🪙${o.reward}`;
    li.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Fulfill';
    btn.disabled = !can;
    btn.setAttribute('aria-label', `Fulfill order for ${needs}, reward ${o.reward} coins`);
    btn.addEventListener('click', () => session.command({ type: 'fulfill', orderId: o.id }));
    li.appendChild(btn);
    ol.appendChild(li);
  }

  // inventory
  const il = $('inventory-list');
  il.innerHTML = '';
  const entries = Object.entries(st.inventory).filter(([, n]) => n > 0);
  if (!entries.length) il.innerHTML = '<li>Empty — plant something!</li>';
  for (const [k, n] of entries) {
    const li = document.createElement('li');
    li.textContent = `${itemName(k)} × ${n}`;
    il.appendChild(li);
  }

  // craft
  const cl = $('craft-list');
  cl.innerHTML = '';
  for (const key of st.allowedRecipes) {
    const r = R.RECIPES[key];
    const can = R.check(st, { type: 'craft', recipe: key }).ok;
    const needs = Object.entries(r.needs).map(([k, n]) => `${n} ${itemName(k)}`).join(' + ');
    const btn = document.createElement('button');
    btn.className = 'btn wide';
    btn.textContent = `${r.name} (${needs})`;
    btn.disabled = !can;
    btn.setAttribute('aria-label', `Craft ${r.name} from ${needs}`);
    btn.addEventListener('click', () => session.command({ type: 'craft', recipe: key }));
    cl.appendChild(btn);
  }
  if (!st.allowedRecipes.length) cl.innerHTML = '<p class="fine">No recipes unlocked in this session.</p>';

  // tool availability
  document.querySelectorAll('.tool[data-crop]').forEach(b => {
    b.disabled = st.allowedCrops.indexOf(b.dataset.crop) < 0;
  });
  $('btn-undo').disabled = !(st.assists && st.assists.undo);

  updateBoardMirror();
  if (renderer) Render.sync(renderer, st, season, {});
}

function itemName(k) {
  return (R.CROPS[k] && R.CROPS[k].name) || (R.RECIPES[k] && R.RECIPES[k].name) || k;
}

function updateBoardMirror() {
  const st = session.state;
  const bm = $('board-mirror');
  bm.innerHTML = '';
  if (!st) return;
  st.plots.forEach((p, i) => {
    const b = document.createElement('button');
    const c = p.crop;
    let label = 'Empty plot ' + (i + 1);
    let icon = '▫';
    if (c) {
      const name = itemName(c.type);
      const stTxt = c.ready ? 'ready to harvest' : (c.watered ? 'watered, growing' : `needs water (${c.age}/${R.CROPS[c.type].grow})`);
      label = `Plot ${i + 1}: ${name}, ${stTxt}`;
      icon = c.ready ? '🌟' : (c.watered ? '💧' : '🌱');
    }
    b.innerHTML = icon + '<span class="sub">' + (i + 1) + '</span>';
    b.setAttribute('aria-label', label);
    if (i === selectedPlot) b.classList.add('selected');
    b.addEventListener('click', () => { selectPlot(i); activatePlot(i); });
    bm.appendChild(b);
  });
}

/* ================= input ================= */
let renderer = null;

function selectPlot(i) {
  selectedPlot = i;
  if (renderer) Render.setSelected(renderer, i);
  updateBoardMirror();
  if (i >= 0 && session.state) {
    const c = session.state.plots[i].crop;
    announce('Plot ' + (i + 1) + ': ' + (c ? itemName(c.type) + (c.ready ? ', ready' : c.watered ? ', watered' : ', needs water') : 'empty'));
  }
}

function activatePlot(i) {
  if (!session.state || session.state.terminalReason) return;
  if (!currentTool) { selectPlot(i); return; }
  const cmd = { type: currentTool.type, plot: i };
  if (currentTool.type === 'plant') cmd.crop = currentTool.crop;
  const res = session.command(cmd);
  if (res.ok) { Audio.sfx.click(); if (settings.haptics && navigator.vibrate) navigator.vibrate(10); }
}

function setTool(btn) {
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
    currentTool = { type: btn.dataset.tool };
    if (btn.dataset.crop) currentTool.crop = btn.dataset.crop;
    announce('Tool selected: ' + btn.textContent.trim());
  } else currentTool = null;
}

function setupInput() {
  const canvas = $('gl');
  let downPos = null, downTime = 0, dragCam = false;

  canvas.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
    downTime = performance.now();
    dragCam = false;
    canvas.setPointerCapture(e.pointerId);
    Audio.resume();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!renderer) return;
    if (downPos) {
      const dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
      const dist = Math.hypot(dx, dy);
      const dt = performance.now() - downTime;
      if (dist > 24 && dt > 120) dragCam = true; // drag/camera gesture threshold
      if (dragCam) {
        // bounded camera orbit on drag (input-safe; raycast truth unchanged)
        renderer.camera.position.x = clamp(renderer.camera.position.x - dx * 0.01, -4, 4);
        renderer.camera.lookAt(renderer.CAM_LOOK);
        downPos = { x: e.clientX, y: e.clientY };
        return;
      }
    }
    const i = Render.raycastPlot(renderer, e.clientX, e.clientY);
    Render.setHovered(renderer, i);
    // legal-target preview
    if (i >= 0 && currentTool && session.state) {
      const cmd = { type: currentTool.type, plot: i, crop: currentTool.crop };
      const chk = R.check(session.state, cmd);
      Render.setGhost(renderer, i, currentTool.type, chk.ok);
    } else Render.setGhost(renderer, -1, null, false);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    Render.setGhost(renderer, -1, null, false);
    if (!renderer) { downPos = null; return; }
    if (!dragCam && downPos) {
      const i = Render.raycastPlot(renderer, e.clientX, e.clientY);
      if (i >= 0) { selectPlot(i); activatePlot(i); }
    }
    downPos = null; dragCam = false;
  });
  canvas.addEventListener('pointercancel', () => {
    downPos = null; dragCam = false;
    if (renderer) Render.setGhost(renderer, -1, null, false);
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const anyScreen = document.querySelector('#screens .screen.open');
    if (e.key === 'Escape') {
      if (anyScreen) backScreen(); else if (session.state) pauseGame();
      e.preventDefault(); return;
    }
    if (anyScreen) return;
    if (!session.state || session.state.terminalReason) return;
    const st = session.state;
    const cols = 4;
    const rows = Math.ceil(st.plots.length / cols);
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        let i = selectedPlot < 0 ? 0 : selectedPlot;
        if (e.key === 'ArrowLeft') i = (i + st.plots.length - 1) % st.plots.length;
        if (e.key === 'ArrowRight') i = (i + 1) % st.plots.length;
        if (e.key === 'ArrowUp') i = (i + st.plots.length - cols) % st.plots.length;
        if (e.key === 'ArrowDown') i = (i + cols) % st.plots.length;
        selectPlot(i);
        break;
      }
      case 'Enter': if (selectedPlot >= 0) activatePlot(selectedPlot); break;
      case '1': setTool(document.querySelector('[data-crop="turnip"]')); break;
      case '2': setTool(document.querySelector('[data-crop="carrot"]')); break;
      case '3': setTool(document.querySelector('[data-crop="pumpkin"]')); break;
      case 'w': case 'W': setTool(document.querySelector('[data-tool="water"]')); break;
      case 'h': case 'H': setTool(document.querySelector('[data-tool="harvest"]')); break;
      case ' ': e.preventDefault(); session.command({ type: 'wait' }); break;
      case 'u': case 'U': session.undo(); break;
      case 'p': case 'P': pauseGame(); break;
      case '?': showHint(); break;
      case 'c': case 'C': if (renderer) { renderer.camera.position.copy(renderer.CAM_POS); renderer.camera.lookAt(renderer.CAM_LOOK); } break;
    }
  });

  // gamepad (focus navigation + confirm/cancel/pause)
  let gpPrev = {};
  function pollGamepad() {
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp && session.state && !document.querySelector('#screens .screen.open')) {
      const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      const edge = (name, v) => { const was = gpPrev[name]; gpPrev[name] = v; return v && !was; };
      const st = session.state;
      const cols = 4;
      if (edge('a', pressed(0)) && selectedPlot >= 0) activatePlot(selectedPlot);
      if (edge('b', pressed(1))) setTool(null);
      if (edge('start', pressed(9))) pauseGame();
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (edge('l', ax < -0.5)) selectPlot((Math.max(0, selectedPlot) + st.plots.length - 1) % st.plots.length);
      if (edge('r', ax > 0.5)) selectPlot((Math.max(0, selectedPlot) + 1) % st.plots.length);
      if (edge('u', ay < -0.5)) selectPlot((Math.max(0, selectedPlot) + st.plots.length - cols) % st.plots.length);
      if (edge('d', ay > 0.5)) selectPlot((Math.max(0, selectedPlot) + cols) % st.plots.length);
    }
    requestAnimationFrame(pollGamepad);
  }
  requestAnimationFrame(pollGamepad);

  document.querySelectorAll('.tool[data-tool]').forEach(b => {
    b.addEventListener('click', () => {
      Audio.resume();
      if (b.dataset.tool === 'wait') { session.command({ type: 'wait' }); return; }
      setTool(b.classList.contains('active') ? null : b);
    });
  });
  $('btn-undo').addEventListener('click', () => session.undo());
  $('btn-hint').addEventListener('click', showHint);
  $('btn-drawer-left').addEventListener('click', () => {
    $('rail-left').classList.toggle('open');
    $('rail-right').classList.remove('open');
  });
  $('btn-drawer-right').addEventListener('click', () => {
    $('rail-right').classList.toggle('open');
    $('rail-left').classList.remove('open');
  });
}

function showHint() {
  if (!session.state) return;
  const legal = R.legalActions(session.state); // same API as play
  const st = session.state;
  let hint = null;
  const f = legal.find(a => a.type === 'fulfill');
  const w = legal.find(a => a.type === 'water');
  const h = legal.find(a => a.type === 'harvest');
  const p = legal.find(a => a.type === 'plant');
  const c = legal.find(a => a.type === 'craft');
  if (f) hint = 'You can fulfill an order right now — press its Fulfill button.';
  else if (h) hint = `Plot ${h.plot + 1} is ready to harvest (tool H).`;
  else if (w) hint = `Plot ${w.plot + 1} needs water (tool W).`;
  else if (c) hint = `You can craft ${itemName(c.recipe)}.`;
  else if (p) hint = `Plant a ${itemName(p.crop)} on plot ${p.plot + 1} (in season now).`;
  else hint = 'Wait (Space) to let time pass.';
  $('hint-banner').textContent = '💡 ' + hint;
  announce('Hint: ' + hint);
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => { $('hint-banner').textContent = ''; }, 6000);
}

/* ================= screens ================= */
function pauseGame() {
  Audio.sfx.pause();
  showScreen('screen-pause');
  analytics.log('pause', {});
}

function showResults(envelope, note) {
  const st = session.state;
  const s = st.score;
  $('results-headline').textContent =
    st.terminalReason === 'goal-complete'
      ? `Homestead goal complete with ${st.maxTicks - st.tick} time to spare!`
      : `Time is up — ${st.ordersFulfilled}/${st.goalOrders} orders fulfilled.`;
  const tb = $('score-breakdown').querySelector('tbody');
  tb.innerHTML = '';
  const labels = { orders: 'Orders', harvests: 'Harvests', crafting: 'Crafting', coins: 'Coins', variety: 'Crop variety', timeBonus: 'Time bonus' };
  for (const k of ['orders', 'harvests', 'crafting', 'coins', 'variety', 'timeBonus']) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th scope="row">${labels[k]}</th><td>${s[k]}</td>`;
    tb.appendChild(tr);
  }
  $('score-total').textContent = s.total;
  $('results-extra').innerHTML = '';
  if (note) $('results-extra').innerHTML = '<p class="fine">' + note + '</p>';
  $('btn-next').style.display = (st.mode === 'journey' && st.terminalReason === 'goal-complete' && progress.journeyStage <= 40) ? '' : 'none';
  announceScore('Session over. ' + $('results-headline').textContent + ' Total score ' + s.total + '.');
  showScreen('screen-results');
}

function setupScreens() {
  $('btn-play').addEventListener('click', () => { Audio.resume(); showScreen('screen-modes'); });
  $('btn-daily').addEventListener('click', () => { Audio.resume(); openSetup('daily'); });
  $('btn-journey').addEventListener('click', () => { Audio.resume(); openSetup('journey'); });
  $('btn-profile').addEventListener('click', () => { renderProfile(); showScreen('screen-profile'); });
  $('btn-help-title').addEventListener('click', () => { renderHelp(); showScreen('screen-help'); });
  $('btn-settings-title').addEventListener('click', () => { renderSettings(); showScreen('screen-settings'); });
  document.querySelectorAll('.mode[data-mode]').forEach(b =>
    b.addEventListener('click', () => openSetup(b.dataset.mode)));
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', backScreen));
  $('btn-pause').addEventListener('click', () => { if (session.state) pauseGame(); });
  $('btn-resume').addEventListener('click', () => { hideScreens(); screenStack = []; setStatus('playing'); });
  $('btn-settings-pause').addEventListener('click', () => { renderSettings(); showScreen('screen-settings'); });
  $('btn-help-pause').addEventListener('click', () => { renderHelp(); showScreen('screen-help'); });
  $('btn-restart-pause').addEventListener('click', () => { session.start(session.config); });
  $('btn-leave').addEventListener('click', () => { session.state = null; store.del('snapshot'); showScreen('screen-title'); refreshTitle(); });
  $('btn-retry').addEventListener('click', () => session.start(session.config));
  $('btn-next').addEventListener('click', () => openSetup('journey'));
  $('btn-results-home').addEventListener('click', () => { showScreen('screen-title'); refreshTitle(); });
  $('btn-leaderboard').addEventListener('click', () => { renderLeaderboard('global'); showScreen('screen-leaderboard'); });
  $('btn-friends').addEventListener('click', () => { renderFriends(); showScreen('screen-friends'); });
  document.querySelectorAll('.lb-tab').forEach(b => b.addEventListener('click', () => renderLeaderboard(b.dataset.board)));
  $('btn-add-friend').addEventListener('click', () => {
    const name = $('friend-name').value.trim();
    if (!name) return;
    if (!progress.friends.includes(name)) progress.friends.push(name);
    $('friend-name').value = '';
    saveProgress(); renderFriends();
  });
  $('btn-share-seed').addEventListener('click', async () => {
    const seed = R.dailySeed(platform.utcDate());
    try { await navigator.clipboard.writeText(seed); announce('Seed copied: ' + seed); }
    catch { announce('Seed: ' + seed); }
  });
  $('btn-tutorial-skip').addEventListener('click', () => {
    $('tutorial-bubble').hidden = true;
    session.tutorialStep = -1;
    progress.tutorialDone = true; saveProgress();
  });
  $('btn-away-continue').addEventListener('click', () => { hideScreens(); setStatus('playing'); });
}

function openSetup(mode) {
  const details = $('setup-details');
  const options = $('setup-options');
  let cfg = null;
  options.innerHTML = '';
  if (mode === 'learn') {
    cfg = R.defaultConfig('learn', 'learn-seed', { maxTicks: 60, goalOrders: 2, plotCount: 8, allowedCrops: ['turnip', 'carrot'], allowedRecipes: [], difficulty: 'easy', assists: { hints: true, undo: true } });
    details.innerHTML = '<p>Interactive lessons. Unranked. About 3 minutes.</p>';
  } else if (mode === 'journey') {
    const st = progress.journeyStage;
    cfg = R.journeyStage(st);
    details.innerHTML = `<p>Stage ${st}/40${cfg.mastery ? ' — <b>Mastery stage</b> (smaller field!)' : ''}. Ranked: no. Goal: ${cfg.goalOrders} orders in ${cfg.maxTicks} ticks.</p>`;
  } else if (mode === 'daily') {
    const date = platform.utcDate();
    const seed = R.dailySeed(date);
    cfg = R.defaultConfig('daily', seed, { maxTicks: 100, goalOrders: 8, difficulty: 'normal' });
    details.innerHTML = `<p>Daily challenge for <b>${date}</b>. One shared seed for everyone. <b>Ranked.</b></p>`;
    if (progress.completedDailies[date]) details.innerHTML += `<p class="fine">Completed today: ${progress.completedDailies[date]} points. You can replay to improve.</p>`;
  } else if (mode === 'practice') {
    cfg = R.defaultConfig('practice', 'practice-' + Math.floor(Math.random() * 1e9), { assists: { hints: true, undo: true } });
    details.innerHTML = '<p>Relaxed play with undo. Unranked, no effect on ratings.</p>';
    options.innerHTML = `<label>Difficulty
      <select id="opt-difficulty">
        <option value="easy">Easy</option><option value="normal" selected>Normal</option><option value="hard">Hard</option>
      </select></label>`;
  } else if (mode === 'challenge') {
    cfg = R.defaultConfig('challenge', 'challenge-blitz', { maxTicks: 40, goalOrders: 5, plotCount: 8, difficulty: 'normal' });
    details.innerHTML = '<p><b>Blitz:</b> fulfill 5 orders in only 40 ticks. Ranked: no.</p>';
    options.innerHTML = `<label>Variant
      <select id="opt-variant">
        <option value="blitz">Blitz (time limit)</option>
        <option value="small">Small field (8 plots)</option>
        <option value="nocraft">No crafting</option>
      </select></label>`;
  } else if (mode === 'score') {
    cfg = R.defaultConfig('score', 'scorechase-' + platform.utcDate(), { maxTicks: 120, goalOrders: 10, difficulty: 'hard' });
    details.innerHTML = '<p>Fixed seed score chase. <b>Ranked</b> on the global board.</p>';
  }
  session._pendingConfig = cfg;
  showScreen('screen-setup');
  $('btn-start-session').onclick = () => {
    let cfg2 = session._pendingConfig;
    if (cfg2.mode === 'practice') {
      const d = $('opt-difficulty').value;
      cfg2 = R.defaultConfig('practice', cfg2.seed, {
        difficulty: d,
        maxTicks: d === 'easy' ? 120 : d === 'hard' ? 70 : 90,
        goalOrders: d === 'easy' ? 4 : d === 'hard' ? 10 : 6,
        assists: { hints: true, undo: true },
      });
    } else if (cfg2.mode === 'challenge') {
      const v = $('opt-variant').value;
      if (v === 'small') cfg2 = R.defaultConfig('challenge', 'challenge-small', { plotCount: 8, maxTicks: 90, goalOrders: 6 });
      else if (v === 'nocraft') cfg2 = R.defaultConfig('challenge', 'challenge-nocraft', { allowedRecipes: [], maxTicks: 90, goalOrders: 6 });
    }
    session.start(cfg2);
  };
}

/* ================= settings ================= */
function saveSettings() { store.set('settings', settings); applySettings(); }
function applySettings() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.documentElement.style.setProperty('--text-scale', settings.textScale);
  $('tooltray').style.direction = settings.leftHanded ? 'rtl' : 'ltr';
  Audio.setMuted(settings.muted);
  for (const b of ['music', 'effects', 'ambience', 'voice']) Audio.setVolume(b, settings.volumes[b]);
  if (renderer) {
    Render.applyQuality(renderer, settings.quality);
    Render.setReducedMotion(renderer, settings.reducedMotion);
    Render.setPalette(renderer, settings.palette);
  }
}
function renderSettings() {
  const f = $('settings-form');
  f.innerHTML = '';
  const row = (label, input) => {
    const l = document.createElement('label');
    l.append(label + ' ', input);
    f.appendChild(l);
  };
  const range = (val, fn) => {
    const i = document.createElement('input');
    i.type = 'range'; i.min = 0; i.max = 1; i.step = 0.05; i.value = val;
    i.addEventListener('input', () => fn(parseFloat(i.value)));
    return i;
  };
  const check = (val, fn) => {
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = val;
    i.addEventListener('change', () => fn(i.checked));
    return i;
  };
  const select = (opts, val, fn) => {
    const s = document.createElement('select');
    for (const o of opts) { const op = document.createElement('option'); op.value = op.textContent = o; s.appendChild(op); }
    s.value = val;
    s.addEventListener('change', () => fn(s.value));
    return s;
  };
  row('Music volume', range(settings.volumes.music, v => { settings.volumes.music = v; saveSettings(); }));
  row('Effects volume', range(settings.volumes.effects, v => { settings.volumes.effects = v; saveSettings(); }));
  row('Ambience volume', range(settings.volumes.ambience, v => { settings.volumes.ambience = v; saveSettings(); }));
  row('Voice volume', range(settings.volumes.voice, v => { settings.volumes.voice = v; saveSettings(); }));
  row('Mute all', check(settings.muted, v => { settings.muted = v; saveSettings(); }));
  row('Graphics quality', select(['low', 'medium', 'high'], settings.quality, v => { settings.quality = v; saveSettings(); }));
  row('Reduced motion', check(settings.reducedMotion, v => { settings.reducedMotion = v; saveSettings(); }));
  row('High contrast', check(settings.highContrast, v => { settings.highContrast = v; saveSettings(); }));
  row('Color palette', select(['default', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'], settings.palette, v => { settings.palette = v; saveSettings(); }));
  row('Larger text', check(settings.textScale > 1, v => { settings.textScale = v ? 1.25 : 1; saveSettings(); }));
  row('Left-handed controls', check(settings.leftHanded, v => { settings.leftHanded = v; saveSettings(); }));
  row('Hold to confirm', check(settings.holdToConfirm, v => { settings.holdToConfirm = v; saveSettings(); }));
  row('Timing assistance', check(settings.timingAssist, v => { settings.timingAssist = v; saveSettings(); }));
  row('Haptics', check(settings.haptics, v => { settings.haptics = v; saveSettings(); }));
  row('Captions', check(settings.captions, v => { settings.captions = v; saveSettings(); }));
  row('Replay tutorial', (() => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Start'; b.addEventListener('click', () => { openSetup('learn'); }); return b; })());
}

/* ================= help ================= */
function renderHelp() {
  const el = $('help-cards');
  el.innerHTML = '';
  const cards = [
    ['Goal', 'Fulfill orders before time runs out. Every action (plant, water, harvest, craft, wait) advances time by one tick.'],
    ['Planting', 'Pick a seed tool (keys 1–3) then a plot. Each crop grows only in its seasons — the banner shows the current season.'],
    ['Watering', 'Crops grow one stage per tick only while watered. Water (W) after every action. A crop left thirsty for 4 ticks withers.'],
    ['Harvest & Craft', 'Harvest (H) ready crops into your inventory. Combine crops into goods like Garden Salad and Harvest Pie for higher order rewards.'],
    ['Orders', 'Orders are listed on the left. When you have the items, the order is highlighted — press Fulfill to earn coins and score.'],
    ['Controls', 'Arrows move between plots, Enter acts, Space waits, U undo (practice), P pause, ? hint, C reset camera. Touch: tap a tool then a plot; drag to orbit the camera.'],
    ['Scoring', 'Score = orders + harvests×5 + crafting×15 + coins + variety×25 + time bonus. Ties break on goal completion, fewer invalid actions, then faster time.'],
  ];
  for (const [t, body] of cards) {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `<h3>${t}</h3><p>${body}</p>`;
    el.appendChild(d);
  }
}

/* ================= leaderboard & friends ================= */
async function renderLeaderboard(board) {
  const list = $('lb-list');
  const note = $('lb-note');
  list.innerHTML = '<li>Loading…</li>';
  note.textContent = '';
  let rows = [];
  if (platform.online) {
    try {
      const res = await platform.api('/leaderboard?board=' + encodeURIComponent(board) +
        (board === 'daily' ? '&date=' + platform.utcDate() : ''));
      rows = res.rows || [];
      note.textContent = res.validated ? 'Ranked: scores validated by server replay.' : 'Casual board: plausibility-checked only.';
    } catch (e) {
      note.textContent = 'Server error: ' + e.message + ' — showing local board.';
      rows = localBoardRows(board);
    }
  } else {
    rows = localBoardRows(board);
    note.textContent = 'Offline casual board (local only).';
  }
  list.innerHTML = '';
  if (!rows.length) list.innerHTML = '<li>No scores yet — be the first!</li>';
  rows.slice(0, 20).forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i + 1}. ${escapeHtml(r.name || 'Player')}</span><span><b>${r.score}</b></span>`;
    list.appendChild(li);
  });
}
function localBoardRows(board) {
  return progress.localBoard.filter(r => board === 'friends' ? progress.friends.includes(r.name) : r.board === (board === 'daily' ? 'daily' : 'global'));
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderFriends() {
  const ul = $('friends-list');
  ul.innerHTML = '';
  if (!progress.friends.length) ul.innerHTML = '<li class="fine">No friends added yet.</li>';
  for (const f of progress.friends) {
    const li = document.createElement('li');
    const best = progress.localBoard.filter(r => r.name === f).map(r => r.score).sort((a, b) => b - a)[0];
    li.innerHTML = `<span>${escapeHtml(f)}</span><span>${best != null ? best + ' pts' : 'no scores'}</span>`;
    ul.appendChild(li);
  }
}

function renderProfile() {
  $('profile-summary').innerHTML =
    `<p>Journey stage ${progress.journeyStage}/40 · Mastery ${progress.masteryXp} XP · Lifetime coins 🪙${progress.lifetimeCoins} · Daily streak ${progress.dailyStreak}</p>`;
  const ul = $('achievements-list');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    const got = !!progress.achievements[a.key];
    li.className = got ? '' : 'locked';
    li.textContent = (got ? '🏅 ' : '🔒 ') + a.name + ' — ' + a.desc;
    ul.appendChild(li);
  }
  const mt = $('mastery-track');
  mt.innerHTML = '';
  const p = document.createElement('progress');
  p.max = 40; p.value = progress.journeyStage - 1;
  mt.appendChild(p);
}

/* ================= title / daily countdown ================= */
function refreshTitle() {
  $('journey-progress-label').textContent = 'Stage ' + progress.journeyStage + '/40';
  updateDailyCountdown();
}
function updateDailyCountdown() {
  const now = platform.now();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  const ms = next.getTime() - now;
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  $('daily-countdown').textContent = `Next seed in ${h}h ${m}m`;
}
setInterval(updateDailyCountdown, 30000);

/* ================= resume / snapshot ================= */
function tryResume() {
  const snap = store.get('snapshot', null);
  if (!snap || snap.schema !== 1) return false;
  try {
    const state = R.deserialize(snap.state);
    if (state.terminalReason) { store.del('snapshot'); return false; }
    session.config = snap.config;
    session.state = state;
    session.log = snap.log || [];
    session.ranked = !!snap.ranked;
    session.undoStack = [];
    session.startedAt = Date.now();
    session.cmdSerial = session.log.length;
    Audio.setSeed(snap.config.seed);
    const awayMin = Math.round((Date.now() - snap.savedAt) / 60000);
    $('away-summary').textContent =
      `Your ${state.mode} session was saved at time ${state.tick}/${state.maxTicks} ` +
      `(${state.ordersFulfilled}/${state.goalOrders} orders${awayMin > 0 ? ', ' + awayMin + ' min ago' : ''}). The solo simulation paused while you were away.`;
    hideScreens();
    showScreen('screen-away');
    refreshAll();
    return true;
  } catch (e) {
    store.del('snapshot');
    return false;
  }
}

/* ================= boot ================= */
const BUILD_VERSION = '1.0.0';
let rafId = 0;
function boot() {
  const lp = $('load-progress');
  lp.value = 20;

  // 3D capability check with graceful fallback
  let gl3d = true;
  try {
    const test = document.createElement('canvas');
    gl3d = !!(test.getContext('webgl2') || test.getContext('webgl'));
  } catch { gl3d = false; }
  if (gl3d) {
    renderer = Render.create(THREE, $('gl'), {});
    if (!renderer) gl3d = false;
  }
  if (!gl3d) $('webgl-fallback').hidden = false;
  lp.value = 50;

  // render loop (heartbeat stops when hidden)
  if (renderer) {
    const loop = (t) => {
      rafId = requestAnimationFrame(loop);
      if (document.hidden) return; // background tabs: zero rendering
      Render.frame(renderer, session.state, session.state ? R.seasonAt(session.state.tick) : 'spring', t);
    };
    rafId = requestAnimationFrame(loop);
    $('gl').addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(rafId);
    });
    $('gl').addEventListener('webglcontextrestored', () => {
      renderer = Render.create(THREE, $('gl'), {}); // rebuild from CPU descriptors
      applySettings();
      if (session.state) Render.sync(renderer, session.state, R.seasonAt(session.state.tick), { instant: true });
    });
  }

  applySettings();
  setupInput();
  setupScreens();
  renderHelp();
  Audio.setCaptionHandler((text) => {
    if (!settings.captions) return;
    $('caption-line').textContent = '♪ ' + text;
    clearTimeout(Audio._capT);
    Audio._capT = setTimeout(() => { $('caption-line').textContent = ''; }, 2000);
  });

  // lifecycle: backgrounding pauses solo sim and saves a safe snapshot
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveSnapshot(); Audio.stop(); }
    else if (session.state && !session.state.terminalReason) { /* resume: snapshot already current */ }
  });
  window.addEventListener('beforeunload', saveSnapshot);

  platform.init().then(() => {
    lp.value = 100;
    $('loading').hidden = true;
    refreshTitle();
    if (!tryResume()) showScreen('screen-title');
  });

  // first gesture unlocks audio
  const unlock = () => { Audio.resume(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);
}

boot();
