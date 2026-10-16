/* Meadowstead — bootstrap, session, UI, input, persistence, platform adapter. */
import * as THREE from 'three';
import * as GFX from './gfx.js';
import { gfxText } from './gfx-strings.js';
import { createPlatform, mergeProgress } from './platform.js';
import { shStrings } from './sh-strings.js';

const R = window.MeadowRules;
const Audio = window.MeadowAudio;
const Render = window.MeadowRender;

const $ = (id) => document.getElementById(id);
// Localization (js/i18n.js): T() translates an English key; N() only marks a key for later T().
const T = (key, vars) => (window.MSI18N ? window.MSI18N.T(key, vars) : String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
const N = (key) => key;
const lang = () => (window.MSI18N ? window.MSI18N.lang : 'en-US');
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
  quality: 'medium', // legacy tier, superseded by `gfx`
  gfx: {},           // graphics: { preset: 'auto'|low|balanced|high|ultra, render_scale, adaptive, show_fps, <category>: tier }
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
if (!settings.gfx || typeof settings.gfx !== 'object') settings.gfx = {};

let progress = store.get('progress', {
  schema: 1, journeyStage: 1, masteryXp: 0, lifetimeCoins: 0,
  achievements: {}, dailyStreak: 0, lastDailyDate: null, completedDailies: {},
  tutorialDone: false, friends: [], localBoard: [],
});

/* ================= platform adapter (js/platform.js over starhermit-sdk.js) ================= */
/* Apply the cloud-save document: progress is always merged with this device's;
   settings are taken only from a newer save; an in-progress session on this
   device is kept (the remote one is used only when there is none here). */
function applyCloudDoc(doc, opts) {
  if (!doc || typeof doc !== 'object') return;
  const newer = !!(opts && opts.newer);
  if (doc.progress && typeof doc.progress === 'object') {
    progress = mergeProgress(progress, doc.progress);
    store.set('progress', progress);
  }
  if (newer && doc.settings && typeof doc.settings === 'object') {
    settings = Object.assign({}, DEFAULT_SETTINGS, doc.settings);
    settings.volumes = Object.assign({}, DEFAULT_SETTINGS.volumes, settings.volumes || {});
    if (!settings.gfx || typeof settings.gfx !== 'object') settings.gfx = {};
    store.set('settings', settings);
    applySettings();
  }
  if (doc.snapshot && !store.get('snapshot', null) && !session.state) store.set('snapshot', doc.snapshot);
}
const platform = createPlatform({
  store,
  buildDoc: () => ({ schema: 1, savedAt: Date.now(), progress, settings, snapshot: store.get('snapshot', null) }),
  applyDoc: applyCloudDoc,
  onIdentity: () => updateIdentityUI(),
  onAuth: (a) => {
    updateIdentityUI();
    refreshAccountButtons();
    if (!a.signedIn) toastShort(shT().signedOut); // keep playing locally
  },
  onMerged: () => { refreshTitle(); if (document.querySelector('#screen-profile.open')) renderProfile(); },
  syncEl: () => $('sb-sync'),
  T,
});
// StarHermit account strings (js/sh-strings.js) in the game's current language.
const shT = () => shStrings([lang()]);

// Sign-in (platform host, no token) / invite (signed in); hidden locally.
function refreshAccountButtons() {
  $('btn-signin').hidden = !platform.canSignIn();
  $('btn-invite').hidden = !platform.hosted;
}
let toastTimer = null;
function toastShort(text) {
  const el = $('sh-toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function updateIdentityUI() {
  const chip = $('sb-player');
  if (chip) {
    chip.hidden = !platform.hosted;
    if (platform.hosted) chip.textContent = '👤 ' + platform.displayName();
  }
  if (document.querySelector('#screen-profile.open')) renderProfile();
}

/* ================= analytics (anonymous funnel, aggregate only) ================= */
const analytics = {
  sessionId: 's-' + Math.random().toString(36).slice(2, 10),
  log(event, data) {
    const line = { t: Date.now(), event, data: data || {} };
    const buf = store.get('funnel', []);
    buf.push(line);
    store.set('funnel', buf.slice(-200)); // local only — no telemetry endpoint exists
  },
};

/* ================= achievements ================= */
const ACHIEVEMENTS = [
  { key: 'first_harvest', name: N('First Harvest'), desc: N('Harvest your first crop.') },
  { key: 'first_order', name: N('Order Up'), desc: N('Fulfill your first order.') },
  { key: 'crafter', name: N('Homestead Kitchen'), desc: N('Craft 10 goods in total.') },
  { key: 'journey_10', name: N('Seasoned Hand'), desc: N('Complete journey stage 10.') },
  { key: 'daily_streak_3', name: N('Three Dawns'), desc: N('Complete the daily challenge 3 days in a row.') },
  { key: 'homestead_restored', name: N('Homestead Restored'), desc: N('Earn 5000 lifetime coins.') },
];
const achievementName = (key) => T((ACHIEVEMENTS.find(a => a.key === key) || { name: key }).name);
let lastAchievement = null; // shown on the results screen; re-rendered on a language change
function unlockAchievement(key) {
  if (progress.achievements[key]) return false; // idempotent
  progress.achievements[key] = Date.now();
  saveProgress();
  Audio.sfx.achievement();
  announce(T('Achievement unlocked: {name}', { name: achievementName(key) }));
  lastAchievement = key;
  const el = $('achievements-earned');
  if (el) el.textContent = '🏅 ' + achievementName(key);
  // achievements stay local (part of the cloud-saved progress doc when signed in)
  return true;
}
function saveProgress() { store.set('progress', progress); platform.cloudSaveSoon(); }

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
    lastSeason = null;
    this.ranked = config.mode === 'daily' || config.mode === 'score';
    if (renderer) { Audio.setSeed(config.seed); Render.setDecorationSeed(renderer, config.seed); }
    else Audio.setSeed(config.seed);
    hideScreens();
    screenStack = [];
    setStatus('playing');
    lastAchievement = null;
    $('achievements-earned').textContent = '';
    announce(T('Session started. {objective}', { objective: objectiveText() }));
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
      // The rejected command still mutated state (invalidActions), so it must stay
      // in the replay log and the snapshot or the authoritative hashes diverge.
      if (res.reason !== 'duplicate-command' && res.reason !== 'missing-command-id') this.log.push(cmd);
      Audio.sfx.invalid();
      showError(cmd, res.reason);
      refreshAll();
      saveSnapshot();
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
    Audio.sfx.undo();
    announce(T('Undone. Back to time {tick}.', { tick: this.state.tick }));
    refreshAll();
    saveSnapshot(); // otherwise a reload restores the move that was just undone
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
      // The stage lives on the session config; the rules engine does not copy it onto state.
      const stage = this.config && this.config.stage;
      if (stage === progress.journeyStage && progress.journeyStage < 40) {
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
    store.del('snapshot');
    // Results are shown before the (possibly slow) ranked submission; the note fills in after.
    showResults(envelope, this.ranked ? (platform.hosted ? () => shT().lbPosting : () => T('Submitting score…')) : '');
    if (!this.ranked) return;
    if (platform.hosted) {
      // Signed in: post the total to the StarHermit high-score board (score-script.js)
      // and show the rank there; the run also stays a personal best on the local board.
      submitLocal(envelope);
      platform.submitScore(st.score.total).then((r) => {
        setSubmissionNote(() => (!r.posted ? shT().lbNotPosted
          : r.rank ? shT().lbRank.replace('{rank}', r.rank) : shT().lbPosted), 'results-lb');
      });
      return;
    }
    submitLocal(envelope);
    setSubmissionNote(() => T('Score recorded on the local board.'));
  },

  snapshotSave() {
    if (!this.state || this.state.terminalReason) return;
    store.set('snapshot', {
      schema: 1, savedAt: Date.now(), config: this.config, log: this.log,
      state: R.serialize(this.state), ranked: this.ranked,
      elapsedMs: Math.max(0, Date.now() - this.startedAt),
    });
    platform.cloudSaveSoon();
  },
};

function submitLocal(envelope) {
  // casual local board with plausibility check
  const replay = replayEnvelope(envelope);
  if (!replay.ok) return;
  progress.localBoard.push({
    name: platform.displayName(), score: replay.score.total, mode: envelope.mode,
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
  { text: N('Welcome! Select the Turnip tool (key 1), then choose an empty plot to plant.'), match: c => c.type === 'plant' },
  { text: N('Good. Now water your crop with the Water tool (key W) on the planted plot.'), match: c => c.type === 'water' },
  { text: N('Crops grow one step each time you act, but only when watered. Keep watering until it is ready.'), match: c => c.type === 'harvest' },
  { text: N('Harvested! Check the orders on the left — grow what they ask for, then fulfill an order.'), match: c => c.type === 'fulfill' },
  { text: N('Orders pay coins and score. Crafting combines crops into valuable goods. Fulfill 2 orders to finish this lesson.'), match: null },
];
function startTutorial() {
  session.tutorialStep = 0;
  showTutorialStep();
}
function showTutorialStep(quiet) {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  const bubble = $('tutorial-bubble');
  if (!step) { bubble.hidden = true; session.tutorialStep = -1; return; }
  $('tutorial-text').textContent = T('Step {n}/{total}: {text}', { n: session.tutorialStep + 1, total: TUTORIAL_STEPS.length, text: T(step.text) });
  bubble.hidden = false;
  if (quiet) return;
  announce(T(step.text));
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
  const text = ERROR_TEXT[reason] ? T(ERROR_TEXT[reason]) : T('Cannot do that: {reason}', { reason });
  $('live-errors').textContent = text;
  $('hint-banner').textContent = '⚠ ' + text;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { $('hint-banner').textContent = ''; }, 3000);
}
const ERROR_TEXT = {
  'wrong-season': N('That crop does not grow in this season.'),
  'plot-occupied': N('That plot already has a crop.'),
  'no-crop': N('There is no crop on that plot.'),
  'already-watered': N('That crop is already watered.'),
  'already-grown': N('That crop is ready — harvest it instead.'),
  'not-ready': N('That crop is not ready yet. Keep watering it.'),
  'missing-ingredients': N('You do not have the ingredients for that recipe.'),
  'missing-items': N('You do not have the items that order needs.'),
  'no-such-order': N('That order is no longer available.'),
  'crop-not-unlocked': N('That crop is not available in this session.'),
  'recipe-not-unlocked': N('That recipe is not available in this session.'),
  'session-over': N('This session has ended.'),
  'duplicate-command': N('That action was already applied.'),
  'undo-not-allowed': N('Undo is only available in Practice mode.'),
  'nothing-to-undo': N('Nothing to undo.'),
};

function objectiveText() {
  const st = session.state;
  if (!st) return '';
  return T('Fulfill {goal} orders before time runs out ({done}/{goal}).', { goal: st.goalOrders, done: st.ordersFulfilled });
}

function setStatus(s) { $('app').dataset.screen = s; }

function hideScreens() {
  document.querySelectorAll('#screens .screen.open').forEach(el => el.classList.remove('open'));
}
let screenStack = [];
function showScreen(id) {
  hideScreens();
  closeDrawers(); // an open phone drawer would otherwise show through the screen overlay
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
let lastSeason = null;
function refreshAll() {
  const st = session.state;
  if (!st) return;
  const season = R.seasonAt(st.tick);
  // Season turns are a rules consequence of the tick, not a rules event: cue them here.
  if (lastSeason && lastSeason !== season) Audio.sfx.season();
  lastSeason = season;
  $('sb-season').textContent = T(SEASON_NAMES[season] || season);
  $('sb-tick').textContent = T('Time {tick}/{max}', { tick: st.tick, max: st.maxTicks });
  $('sb-coins').textContent = '🪙 ' + st.coins;
  const scoreSoFar = R.computeScore(Object.assign({}, st, { terminalReason: st.terminalReason || 'x' }));
  $('sb-score').textContent = T('Score {n}', { n: st.score ? st.score.total : scoreSoFar.total - scoreSoFar.timeBonus });
  $('sb-mode').textContent = T(MODE_NAMES[st.mode] || st.mode);
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
    btn.textContent = T('Fulfill');
    btn.disabled = !can;
    btn.setAttribute('aria-label', T('Fulfill order for {needs}, reward {reward} coins', { needs, reward: o.reward }));
    btn.addEventListener('click', () => session.command({ type: 'fulfill', orderId: o.id }));
    li.appendChild(btn);
    ol.appendChild(li);
  }

  // inventory
  const il = $('inventory-list');
  il.innerHTML = '';
  const entries = Object.entries(st.inventory).filter(([, n]) => n > 0);
  if (!entries.length) { const li = document.createElement('li'); li.textContent = T('Empty — plant something!'); il.appendChild(li); }
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
    btn.textContent = `${itemName(key)} (${needs})`;
    btn.disabled = !can;
    btn.setAttribute('aria-label', T('Craft {name} from {needs}', { name: itemName(key), needs }));
    btn.addEventListener('click', () => session.command({ type: 'craft', recipe: key }));
    cl.appendChild(btn);
  }
  if (!st.allowedRecipes.length) { const p = document.createElement('p'); p.className = 'fine'; p.textContent = T('No recipes unlocked in this session.'); cl.appendChild(p); }

  // tool availability
  document.querySelectorAll('.tool[data-crop]').forEach(b => {
    b.disabled = st.allowedCrops.indexOf(b.dataset.crop) < 0;
  });
  $('btn-undo').disabled = !(st.assists && st.assists.undo);

  updateBoardMirror();
  if (renderer) Render.sync(renderer, st, season, {});
}

const ITEM_NAMES = { turnip: N('Turnip'), carrot: N('Carrot'), pumpkin: N('Pumpkin'), salad: N('Garden Salad'), pie: N('Harvest Pie') };
const SEASON_NAMES = { spring: N('Spring'), summer: N('Summer'), autumn: N('Autumn') };
const MODE_NAMES = { learn: N('Learn'), journey: N('Journey'), daily: N('Daily'), practice: N('Practice'), challenge: N('Challenge'), score: N('Score Chase') };
function itemName(k) {
  if (ITEM_NAMES[k]) return T(ITEM_NAMES[k]);
  return (R.CROPS[k] && R.CROPS[k].name) || (R.RECIPES[k] && R.RECIPES[k].name) || k;
}

function updateBoardMirror() {
  const st = session.state;
  const bm = $('board-mirror');
  // the mirror is rebuilt after every action: remember which plot button had focus
  const focused = document.activeElement;
  const focusIndex = focused && focused.parentElement === bm && focused.matches(':focus-visible')
    ? Array.prototype.indexOf.call(bm.children, focused) : -1;
  bm.innerHTML = '';
  if (!st) return;
  st.plots.forEach((p, i) => {
    const b = document.createElement('button');
    const c = p.crop;
    let label = T('Empty plot {n}', { n: i + 1 });
    let icon = '▫';
    if (c) {
      const name = itemName(c.type);
      const stTxt = c.ready ? T('ready to harvest') : (c.watered ? T('watered, growing') : T('needs water ({age}/{grow})', { age: c.age, grow: R.CROPS[c.type].grow }));
      label = T('Plot {n}: {name}, {state}', { n: i + 1, name, state: stTxt });
      icon = c.ready ? '🌟' : (c.watered ? '💧' : '🌱');
    }
    b.innerHTML = icon + '<span class="sub">' + (i + 1) + '</span>';
    b.setAttribute('aria-label', i === selectedPlot ? T('{label}, selected', { label }) : label);
    if (i === selectedPlot) b.classList.add('selected');
    b.addEventListener('click', () => { selectPlot(i); activatePlot(i); });
    bm.appendChild(b);
  });
  // keep keyboard focus on the mirror, following the current selection
  if (focusIndex >= 0) {
    const target = bm.children[selectedPlot] || bm.children[focusIndex];
    if (target) target.focus();
  }
}

/* ================= input ================= */
let renderer = null;

function drawersOpen() {
  return $('rail-left').classList.contains('open') || $('rail-right').classList.contains('open');
}
function syncDrawers() {
  $('btn-drawer-left').setAttribute('aria-expanded', String($('rail-left').classList.contains('open')));
  $('btn-drawer-right').setAttribute('aria-expanded', String($('rail-right').classList.contains('open')));
}
function closeDrawers() {
  $('rail-left').classList.remove('open');
  $('rail-right').classList.remove('open');
  syncDrawers();
}

function selectPlot(i) {
  selectedPlot = i;
  if (renderer) Render.setSelected(renderer, i);
  updateBoardMirror();
  if (i >= 0 && session.state) {
    const c = session.state.plots[i].crop;
    const what = !c ? T('empty') : c.ready ? T('{name}, ready', { name: itemName(c.type) })
      : c.watered ? T('{name}, watered', { name: itemName(c.type) }) : T('{name}, needs water', { name: itemName(c.type) });
    announce(T('Plot {n}: {state}', { n: i + 1, state: what }));
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
    announce(T('Tool selected: {tool}', { tool: btn.textContent.trim() }));
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
    const act = codeToAction.get(e.code);
    if (act === 'back') {
      // an open drawer covers its own toggle on phones, so Escape must dismiss it first
      if (!anyScreen && drawersOpen()) closeDrawers();
      else if (anyScreen) backScreen();
      else if (session.state) pauseGame();
      e.preventDefault(); return;
    }
    if (anyScreen) return;
    if (!session.state || session.state.terminalReason) return;
    // Enter/Space on a focused control belongs to that control — handling it here
    // as well would fire the button and a plot action from one keypress.
    if ((act === 'activate' || act === 'wait') && e.target.closest && e.target.closest('button, select, a[href]')) return;
    const st = session.state;
    const cols = 4;
    switch (act) {
      case 'left': case 'right': case 'up': case 'down': {
        e.preventDefault();
        let i = selectedPlot < 0 ? 0 : selectedPlot;
        if (act === 'left') i = (i + st.plots.length - 1) % st.plots.length;
        if (act === 'right') i = (i + 1) % st.plots.length;
        if (act === 'up') i = (i + st.plots.length - cols) % st.plots.length;
        if (act === 'down') i = (i + cols) % st.plots.length;
        selectPlot(i);
        break;
      }
      case 'activate': if (selectedPlot >= 0) activatePlot(selectedPlot); break;
      case 'turnip': setTool(document.querySelector('[data-crop="turnip"]')); break;
      case 'carrot': setTool(document.querySelector('[data-crop="carrot"]')); break;
      case 'pumpkin': setTool(document.querySelector('[data-crop="pumpkin"]')); break;
      case 'water': setTool(document.querySelector('[data-tool="water"]')); break;
      case 'harvest': setTool(document.querySelector('[data-tool="harvest"]')); break;
      case 'wait': e.preventDefault(); session.command({ type: 'wait' }); break;
      case 'undo': session.undo(); break;
      case 'pause': pauseGame(); break;
      case 'hint': showHint(); break;
      case 'camera': if (renderer) { renderer.camera.position.copy(renderer.CAM_POS); renderer.camera.lookAt(renderer.CAM_LOOK); } break;
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
  // Tapping outside an open drawer closes it: on phones the drawer overlays the
  // status bar, hiding the toggle that opened it.
  document.addEventListener('pointerdown', (e) => {
    if (!drawersOpen()) return;
    if (e.target.closest && e.target.closest('#rail-left, #rail-right, .drawer-toggle')) return;
    closeDrawers();
  });
  $('btn-drawer-left').addEventListener('click', () => {
    $('rail-left').classList.toggle('open');
    $('rail-right').classList.remove('open');
    syncDrawers();
  });
  $('btn-drawer-right').addEventListener('click', () => {
    $('rail-right').classList.toggle('open');
    $('rail-left').classList.remove('open');
    syncDrawers();
  });
  syncDrawers();

  // A pointer click leaves the HUD button focused, so the next Enter/Space would
  // re-activate it instead of playing. Drop focus after real pointer clicks only.
  document.addEventListener('click', (e) => {
    if (!e.detail) return; // keyboard-synthesised click: keep focus where it is
    const btn = e.target.closest && e.target.closest('button');
    if (btn && !btn.closest('#screens') && !btn.closest('#tutorial-bubble')) btn.blur();
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
  if (f) hint = T('You can fulfill an order right now — press its Fulfill button.');
  else if (h) hint = T('Plot {n} is ready to harvest (tool H).', { n: h.plot + 1 });
  else if (w) hint = T('Plot {n} needs water (tool W).', { n: w.plot + 1 });
  else if (c) hint = T('You can craft {item}.', { item: itemName(c.recipe) });
  else if (p) hint = T('Plant a {item} on plot {n} (in season now).', { item: itemName(p.crop), n: p.plot + 1 });
  else hint = T('Wait (Space) to let time pass.');
  $('hint-banner').textContent = '💡 ' + hint;
  announce(T('Hint: {hint}', { hint }));
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => { $('hint-banner').textContent = ''; }, 6000);
}

/* ================= screens ================= */
function pauseGame() {
  Audio.sfx.pause();
  showScreen('screen-pause');
  analytics.log('pause', {});
}

// The note is a thunk so it follows a language change while the results are shown.
let submissionNote = null;
function setSubmissionNote(note, id) {
  submissionNote = note ? { note, id } : null;
  renderSubmissionNote();
}
function renderSubmissionNote() {
  const el = $('results-extra');
  el.innerHTML = '';
  if (!submissionNote) return;
  const p = document.createElement('p');
  if (submissionNote.id) p.id = submissionNote.id;
  p.className = 'fine';
  p.textContent = typeof submissionNote.note === 'function' ? submissionNote.note() : submissionNote.note;
  el.appendChild(p);
}

function renderResultsText() {
  const st = session.state;
  if (!st || !st.score) return;
  const s = st.score;
  $('results-headline').textContent =
    st.terminalReason === 'goal-complete'
      ? T('Homestead goal complete with {left} time to spare!', { left: st.maxTicks - st.tick })
      : T('Time is up — {done}/{goal} orders fulfilled.', { done: st.ordersFulfilled, goal: st.goalOrders });
  const tb = $('score-breakdown').querySelector('tbody');
  tb.innerHTML = '';
  const labels = { orders: N('Orders'), harvests: N('Harvests'), crafting: N('Crafting'), coins: N('Coins'), variety: N('Crop variety'), timeBonus: N('Time bonus') };
  for (const k of ['orders', 'harvests', 'crafting', 'coins', 'variety', 'timeBonus']) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = T(labels[k]);
    const td = document.createElement('td');
    td.textContent = s[k];
    tr.append(th, td);
    tb.appendChild(tr);
  }
  $('score-total').textContent = s.total;
  if (lastAchievement) $('achievements-earned').textContent = '🏅 ' + achievementName(lastAchievement);
  renderSubmissionNote();
}

function showResults(envelope, note) {
  const st = session.state;
  const s = st.score;
  submissionNote = note ? { note } : null;
  renderResultsText();
  $('btn-next').style.display = (st.mode === 'journey' && st.terminalReason === 'goal-complete' && progress.journeyStage <= 40) ? '' : 'none';
  announceScore(T('Session over. {headline} Total score {total}.', { headline: $('results-headline').textContent, total: s.total }));
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
    try { await navigator.clipboard.writeText(seed); announce(T('Seed copied: {seed}', { seed })); }
    catch { announce(T('Seed: {seed}', { seed })); }
  });
  $('btn-tutorial-skip').addEventListener('click', () => {
    $('tutorial-bubble').hidden = true;
    session.tutorialStep = -1;
    progress.tutorialDone = true; saveProgress();
  });
  // clear the stack too, or backing out of a later pause re-opens "Welcome back"
  $('btn-away-continue').addEventListener('click', () => { hideScreens(); screenStack = []; setStatus('playing'); });
}

// Setup text is rebuilt from the pending config, so a language change keeps the
// session's seed and the selected difficulty / variant.
function renderSetupText() {
  const cfg = session._pendingConfig;
  if (!cfg) return;
  const details = $('setup-details');
  const options = $('setup-options');
  const mode = cfg.mode;
  const prevSelect = options.querySelector('select');
  const prev = prevSelect ? prevSelect.value : null;
  const para = (html, cls) => `<p${cls ? ' class="' + cls + '"' : ''}>${html}</p>`;
  options.innerHTML = '';
  if (mode === 'learn') {
    details.innerHTML = para(T('Interactive lessons. Unranked. About 3 minutes.'));
  } else if (mode === 'journey') {
    const vars = { stage: session._pendingStage, goal: cfg.goalOrders, ticks: cfg.maxTicks };
    details.innerHTML = para(cfg.mastery
      ? T('Stage {stage}/40 — <b>Mastery stage</b> (smaller field!). Ranked: no. Goal: {goal} orders in {ticks} ticks.', vars)
      : T('Stage {stage}/40. Ranked: no. Goal: {goal} orders in {ticks} ticks.', vars));
  } else if (mode === 'daily') {
    const date = session._pendingDate;
    details.innerHTML = para(T('Daily challenge for <b>{date}</b>. One shared seed for everyone.', { date }) + ' ' +
      (platform.hosted ? T('Your result is kept as a personal best, synced to your cloud save.') : T('<b>Ranked.</b>')));
    if (progress.completedDailies[date]) details.innerHTML += para(T('Completed today: {points} points. You can replay to improve.', { points: progress.completedDailies[date] }), 'fine');
  } else if (mode === 'practice') {
    details.innerHTML = para(T('Relaxed play with undo. Unranked, no effect on ratings.'));
    options.innerHTML = `<label>${T('Difficulty')}
      <select id="opt-difficulty">
        <option value="easy">${T('Easy')}</option><option value="normal" selected>${T('Normal')}</option><option value="hard">${T('Hard')}</option>
      </select></label>`;
  } else if (mode === 'challenge') {
    details.innerHTML = para(T('<b>Blitz:</b> fulfill 5 orders in only 40 ticks. Ranked: no.'));
    options.innerHTML = `<label>${T('Variant')}
      <select id="opt-variant">
        <option value="blitz">${T('Blitz (time limit)')}</option>
        <option value="small">${T('Small field (8 plots)')}</option>
        <option value="nocraft">${T('No crafting')}</option>
      </select></label>`;
  } else if (mode === 'score') {
    details.innerHTML = para(platform.hosted
      ? T('Fixed seed score chase. <b>Ranked</b> on the StarHermit leaderboard.')
      : T('Fixed seed score chase. <b>Ranked</b> on the global board.'));
  }
  const sel = options.querySelector('select');
  if (sel && prev) sel.value = prev;
}

function openSetup(mode) {
  let cfg = null;
  $('setup-options').innerHTML = '';
  if (mode === 'learn') {
    cfg = R.defaultConfig('learn', 'learn-seed', { maxTicks: 60, goalOrders: 2, plotCount: 8, allowedCrops: ['turnip', 'carrot'], allowedRecipes: [], difficulty: 'easy', assists: { hints: true, undo: true } });
  } else if (mode === 'journey') {
    session._pendingStage = progress.journeyStage;
    cfg = R.journeyStage(progress.journeyStage);
  } else if (mode === 'daily') {
    const date = platform.utcDate();
    session._pendingDate = date;
    cfg = R.defaultConfig('daily', R.dailySeed(date), { maxTicks: 100, goalOrders: 8, difficulty: 'normal' });
  } else if (mode === 'practice') {
    cfg = R.defaultConfig('practice', 'practice-' + Math.floor(Math.random() * 1e9), { assists: { hints: true, undo: true } });
  } else if (mode === 'challenge') {
    cfg = R.defaultConfig('challenge', 'challenge-blitz', { maxTicks: 40, goalOrders: 5, plotCount: 8, difficulty: 'normal' });
  } else if (mode === 'score') {
    cfg = R.defaultConfig('score', 'scorechase-' + platform.utcDate(), { maxTicks: 120, goalOrders: 10, difficulty: 'hard' });
  }
  session._pendingConfig = cfg;
  renderSetupText();
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

/* ================= key bindings ================= */
// Defaults mirror the control.* lines in starhermit.txt; the player's
// StarHermit bindings replace them at boot. Routed by KeyboardEvent.code.
const DEFAULT_BINDINGS = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  activate: ['Enter'], turnip: ['Digit1'], carrot: ['Digit2'], pumpkin: ['Digit3'],
  water: ['KeyW'], harvest: ['KeyH'], wait: ['Space'], undo: ['KeyU'], pause: ['KeyP'],
  hint: ['Slash'], camera: ['KeyC'], back: ['Escape'],
};
let codeToAction = new Map();
let bindings = DEFAULT_BINDINGS;
const keysFor = (action) => (bindings[action] || []).map(keyLabel).join('/');
function keyLabel(code) {
  const named = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Space: '␣', Slash: '?' };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code || '—';
}
function setBindings(b) {
  bindings = b;
  codeToAction = new Map();
  for (const [action, codes] of Object.entries(b)) for (const c of codes) codeToAction.set(c, action);
  // tool-tray key hints show the effective bindings
  document.querySelectorAll('kbd[data-key]').forEach((k) => {
    const codes = b[k.dataset.key] || [];
    k.textContent = codes.map(keyLabel).join('/');
    const btn = k.closest('[aria-keyshortcuts]');
    if (btn) btn.setAttribute('aria-keyshortcuts', codes.map(keyLabel).join(' '));
  });
}
setBindings(DEFAULT_BINDINGS);

/* ================= settings ================= */
function saveSettings() {
  store.set('settings', settings);
  platform.cloudSaveSoon();
  platform.pushSettings(settings); // per-player StarHermit settings KV (changed keys only)
  applySettings();
}
function applySettings() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.documentElement.style.setProperty('--text-scale', settings.textScale);
  $('tooltray').style.direction = settings.leftHanded ? 'rtl' : 'ltr';
  Audio.setMuted(settings.muted);
  for (const b of ['music', 'effects', 'ambience', 'voice']) Audio.setVolume(b, settings.volumes[b]);
  if (renderer) {
    const gfxJson = JSON.stringify(settings.gfx || {});
    if (gfxJson !== appliedGfx) { appliedGfx = gfxJson; Render.setGraphics(renderer, settings.gfx || {}); }
    Render.setReducedMotion(renderer, settings.reducedMotion || osReducedMotion());
    Render.setPalette(renderer, settings.palette);
  }
}
let appliedGfx = null;
function osReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/* ---- Settings → Graphics (quality model in js/gfx.js, strings in js/gfx-strings.js) ---- */
const GT = (key, vars) => gfxText(lang(), key, vars);
function saveGfx(next) {
  settings.gfx = next;
  saveSettings();
  renderGraphicsSection();
}
function gfxSummary() {
  if (!renderer) return;
  const info = Render.graphicsInfo(renderer);
  const words = {};
  for (const k of ['noShadows', 'shadows', 'aoFull', 'ao', 'bloom', 'reflections', 'noAA']) words[k] = GT('w_' + k);
  $('gfx-summary').textContent = (info.gpu || GT('unknownGpu')) + ' · ' + GFX.describe(info.resolved, info.pixels, words);
  $('gfx-post-note').hidden = !info.postFailed;
}
function renderGraphicsSection() {
  // Redraw only the game's own box: the shared Language / Sound / Report
  // sections (game-options.js) are mounted after it in #gfx-section.
  const sec = $('gfx-own');
  const outer = $('gfx-section');
  if (!sec || !outer) return;
  sec.innerHTML = '';
  const saved = settings.gfx || {};
  const detected = renderer ? Render.graphicsInfo(renderer).detected : 'low';
  const r = GFX.resolve(saved, detected);
  const h = document.createElement('h2');
  h.id = 'gfx-h';
  h.textContent = GT('section');
  outer.setAttribute('aria-labelledby', 'gfx-h');
  sec.appendChild(h);
  const row = (id, label, input, extra) => {
    const l = document.createElement('label');
    l.htmlFor = id;
    const span = document.createElement('span');
    span.textContent = label;
    input.id = id;
    l.append(span);
    if (extra) { const wrap = document.createElement('span'); wrap.className = 'gfx-inline'; wrap.append(input, extra); l.append(wrap); }
    else l.append(input);
    sec.appendChild(l);
  };
  const select = (opts, val, fn) => {
    const s = document.createElement('select');
    for (const [v, t] of opts) { const op = document.createElement('option'); op.value = v; op.textContent = t; s.appendChild(op); }
    s.value = val;
    s.addEventListener('change', () => fn(s.value));
    return s;
  };
  const check = (val, fn) => {
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = val;
    i.addEventListener('change', () => fn(i.checked));
    return i;
  };
  // Quality preset: choosing one clears every per-category override.
  const presetOpts = [['auto', GT('auto', { tier: GT('p_' + detected) })]].concat(GFX.PRESETS.map((p) => [p, GT('p_' + p)]));
  row('gfx-preset', GT('quality'), select(presetOpts, GFX.PRESETS.includes(saved.preset) ? saved.preset : 'auto',
    (v) => saveGfx(GFX.choosePreset(settings.gfx, v))));
  // Render scale 50–200 %.
  const scale = document.createElement('input');
  scale.type = 'range'; scale.min = 50; scale.max = 200; scale.step = 5;
  scale.value = Math.round(r.renderScale * 100);
  const out = document.createElement('output');
  out.id = 'gfx-scale-value';
  out.textContent = scale.value + '%';
  scale.addEventListener('input', () => { out.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => saveGfx(Object.assign({}, settings.gfx, { render_scale: Number(scale.value) / 100 })));
  row('gfx-scale', GT('renderScale'), scale, out);
  // One select per category, "From preset (<tier>)" by default.
  for (const [cat, tiers] of Object.entries(GFX.CATEGORIES)) {
    const opts = [['preset', GT('fromPreset', { tier: GT('t_' + GFX.presetTier(r.preset, cat)) })]]
      .concat(tiers.map((t) => [t, GT('t_' + t)]));
    const sel = select(opts, tiers.includes(saved[cat]) ? saved[cat] : 'preset', (v) => {
      const next = Object.assign({}, settings.gfx);
      if (v === 'preset') delete next[cat]; else next[cat] = v;
      saveGfx(next);
    });
    sel.dataset.gfxCat = cat;
    row('gfx-cat-' + cat, GT('c_' + cat), sel);
  }
  row('gfx-adaptive', GT('adaptive'), check(r.adaptive, (v) => saveGfx(Object.assign({}, settings.gfx, { adaptive: v }))));
  row('gfx-fps', GT('showFps'), check(r.showFps, (v) => saveGfx(Object.assign({}, settings.gfx, { show_fps: v }))));
  const sum = document.createElement('p');
  sum.id = 'gfx-summary'; sum.className = 'fine'; sum.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.id = 'gfx-post-note'; note.className = 'fine'; note.hidden = true; note.textContent = GT('postFailed');
  sec.append(sum, note);
  document.body.dataset.gfxPreset = r.preset;
  gfxSummary();
  // The drawing-buffer size settles on the next frame; refresh the summary then.
  requestAnimationFrame(() => requestAnimationFrame(() => { if ($('gfx-summary')) gfxSummary(); }));
}
function renderSettings() {
  // Built once: the game's rows (#settings-own) and Graphics box (#gfx-own) are
  // redrawn in place; the shared options mounted in #gfx-section stay.
  const form = $('settings-form');
  let f = $('settings-own');
  if (!f) {
    form.innerHTML = '';
    f = document.createElement('div');
    f.id = 'settings-own';
    f.className = 'settings-own';
    const gsec = document.createElement('section');
    gsec.id = 'gfx-section';
    gsec.className = 'gfx-section';
    const own = document.createElement('div');
    own.id = 'gfx-own';
    own.className = 'gfx-own';
    gsec.appendChild(own);
    form.append(f, gsec);
  }
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
    for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = T(PALETTE_NAMES[o] || o); s.appendChild(op); }
    s.value = val;
    s.addEventListener('change', () => fn(s.value));
    return s;
  };
  row(T('Music volume'), range(settings.volumes.music, v => { settings.volumes.music = v; saveSettings(); }));
  row(T('Effects volume'), range(settings.volumes.effects, v => { settings.volumes.effects = v; saveSettings(); }));
  row(T('Ambience volume'), range(settings.volumes.ambience, v => { settings.volumes.ambience = v; saveSettings(); }));
  row(T('Voice volume'), range(settings.volumes.voice, v => { settings.volumes.voice = v; saveSettings(); }));
  row(T('Mute all'), check(settings.muted, v => { settings.muted = v; saveSettings(); }));
  row(T('Reduced motion'), check(settings.reducedMotion, v => { settings.reducedMotion = v; saveSettings(); }));
  row(T('High contrast'), check(settings.highContrast, v => { settings.highContrast = v; saveSettings(); }));
  row(T('Color palette'), select(['default', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'], settings.palette, v => { settings.palette = v; saveSettings(); }));
  row(T('Larger text'), check(settings.textScale > 1, v => { settings.textScale = v ? 1.25 : 1; saveSettings(); }));
  row(T('Left-handed controls'), check(settings.leftHanded, v => { settings.leftHanded = v; saveSettings(); }));
  row(T('Hold to confirm'), check(settings.holdToConfirm, v => { settings.holdToConfirm = v; saveSettings(); }));
  row(T('Timing assistance'), check(settings.timingAssist, v => { settings.timingAssist = v; saveSettings(); }));
  row(T('Haptics'), check(settings.haptics, v => { settings.haptics = v; saveSettings(); }));
  row(T('Captions'), check(settings.captions, v => { settings.captions = v; saveSettings(); }));
  row(T('Replay tutorial'), (() => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = T('Start'); b.addEventListener('click', () => { openSetup('learn'); }); return b; })());
  renderGraphicsSection();
}
const PALETTE_NAMES = { default: N('Default'), deuteranopia: N('Deuteranopia'), protanopia: N('Protanopia'), tritanopia: N('Tritanopia'), 'high-contrast': N('High contrast') };

/* ================= help ================= */
function renderHelp() {
  const el = $('help-cards');
  el.innerHTML = '';
  const cards = [
    [T('Goal'), T('Fulfill orders before time runs out. Every action (plant, water, harvest, craft, wait) advances time by one tick.')],
    [T('Planting'), T('Pick a seed tool (keys 1–3) then a plot. Each crop grows only in its seasons — the banner shows the current season.')],
    [T('Watering'), T('Crops grow one stage per tick only while watered. Water (W) after every action. A crop left thirsty for 4 ticks withers.')],
    [T('Harvest & Craft'), T('Harvest (H) ready crops into your inventory. Combine crops into goods like Garden Salad and Harvest Pie for higher order rewards.')],
    [T('Orders'), T('Orders are listed on the left. When you have the items, the order is highlighted — press Fulfill to earn coins and score.')],
    [T('Controls'), T('{move} move between plots, {act} acts, {wait} waits, {undo} undo (practice), {pause} pause, {hint} hint, {camera} reset camera, {back} back. Touch: tap a tool then a plot; drag to orbit the camera.', {
      move: ['left', 'right', 'up', 'down'].map(keysFor).join(' '), act: keysFor('activate'), wait: keysFor('wait'), undo: keysFor('undo'),
      pause: keysFor('pause'), hint: keysFor('hint'), camera: keysFor('camera'), back: keysFor('back'),
    })],
    [T('Scoring'), T('Score = orders + harvests×5 + crafting×15 + coins + variety×25 + time bonus. Ties break on goal completion, fewer invalid actions, then faster time.')],
  ];
  for (const [t, body] of cards) {
    const d = document.createElement('div');
    d.className = 'card';
    const h = document.createElement('h3');
    h.textContent = t;
    const p = document.createElement('p');
    p.textContent = body;
    d.append(h, p);
    el.appendChild(d);
  }
}

/* ================= leaderboard & friends ================= */
let currentBoard = 'global';
async function renderLeaderboard(board) {
  currentBoard = board;
  const list = $('lb-list');
  const note = $('lb-note');
  list.innerHTML = '';
  const loading = document.createElement('li');
  loading.textContent = T('Loading…');
  list.appendChild(loading);
  note.textContent = '';
  let rows = [];
  if (platform.hosted) {
    try {
      if (board === 'daily') {
        // the platform leaderboard is a single board; per-day rows live on the local board
        rows = localBoardRows('daily');
        note.textContent = T("Today's seed — your scores (local). The platform board is global.");
      } else {
        rows = await platform.leaderboardEntries(board === 'friends');
        note.textContent = board === 'friends'
          ? T('Platform leaderboard — friends only (read-only). Ranked rows are validated platform-side.')
          : T('Platform leaderboard (read-only). Ranked rows are validated platform-side.');
        if (!rows.length) {
          note.textContent += ' ' + T('No platform entries — showing local records.');
          rows = localBoardRows(board);
        }
      }
    } catch (e) {
      note.textContent = T('Platform leaderboard unavailable ({error}) — showing local board.', { error: e.message });
      rows = localBoardRows(board);
    }
  } else {
    rows = localBoardRows(board);
    note.textContent = T('Local board (this device).');
  }
  if (board !== currentBoard) return; // a newer tab (or language refresh) took over
  list.innerHTML = '';
  if (!rows.length) { const li = document.createElement('li'); li.textContent = T('No scores yet — be the first!'); list.appendChild(li); }
  rows.slice(0, 20).forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i + 1}. ${escapeHtml(r.name || T('Player'))}</span><span><b>${r.score}</b></span>`;
    list.appendChild(li);
  });
}
function localBoardRows(board) {
  return progress.localBoard.filter(r => board === 'friends' ? progress.friends.includes(r.name) : r.board === (board === 'daily' ? 'daily' : 'global'));
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function renderFriends() {
  const ul = $('friends-list');
  const addRow = $('friend-name').parentElement;
  ul.innerHTML = '';
  if (platform.hosted) {
    // friends come from the platform account; the free-text add row is local-dev only
    addRow.style.display = 'none';
    let friends = [];
    try { friends = await platform.friends(); } catch { friends = []; }
    let entries = [];
    try { entries = await platform.leaderboardEntries(true); } catch { entries = []; }
    const best = {};
    for (const e of entries) best[String(e.userId)] = e.score;
    ul.innerHTML = '';
    if (!friends.length) ul.innerHTML = `<li class="fine">${escapeHtml(T('No friends on the platform yet. Use Invite a friend to send a link.'))}</li>`;
    for (const f of friends) {
      const score = best[String(f.userId)];
      const li = document.createElement('li');
      li.innerHTML = `<span>${f.online ? '🟢 ' : ''}${escapeHtml(f.name)}</span><span>${escapeHtml(score != null ? T('{n} pts', { n: score }) : T('no scores'))}</span>`;
      ul.appendChild(li);
    }
    return;
  }
  addRow.style.display = '';
  if (!progress.friends.length) ul.innerHTML = `<li class="fine">${escapeHtml(T('No friends added yet.'))}</li>`;
  for (const f of progress.friends) {
    const li = document.createElement('li');
    const best = progress.localBoard.filter(r => r.name === f).map(r => r.score).sort((a, b) => b - a)[0];
    li.innerHTML = `<span>${escapeHtml(f)}</span><span>${escapeHtml(best != null ? T('{n} pts', { n: best }) : T('no scores'))}</span>`;
    ul.appendChild(li);
  }
}

function renderProfile() {
  const who = platform.hosted
    ? `<p class="fine">${T('Playing as <b>{name}</b> · cloud save: {sync}', { name: escapeHtml(platform.displayName()), sync: escapeHtml(platform.syncText()) })}</p>`
    : `<p class="fine">${T('Local profile — progress is saved on this device.')}</p>`;
  $('profile-summary').innerHTML = who +
    `<p>${T('Journey stage {stage}/40 · Mastery {xp} XP · Lifetime coins 🪙{coins} · Daily streak {streak}', { stage: progress.journeyStage, xp: progress.masteryXp, coins: progress.lifetimeCoins, streak: progress.dailyStreak })}</p>`;
  const ul = $('achievements-list');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    const got = !!progress.achievements[a.key];
    li.className = got ? '' : 'locked';
    li.textContent = (got ? '🏅 ' : '🔒 ') + T(a.name) + ' — ' + T(a.desc);
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
  $('journey-progress-label').textContent = T('Stage {stage}/40', { stage: progress.journeyStage });
  updateDailyCountdown();
}
function updateDailyCountdown() {
  const now = platform.now();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  const ms = next.getTime() - now;
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  $('daily-countdown').textContent = T('Next seed in {h}h {m}m', { h, m });
}
setInterval(updateDailyCountdown, 30000);

/* ================= resume / snapshot ================= */
let awaySummary = null;
function renderAwaySummary() {
  if (!awaySummary) return;
  const { state, awayMin } = awaySummary;
  const vars = { mode: T(MODE_NAMES[state.mode] || state.mode), tick: state.tick, max: state.maxTicks, done: state.ordersFulfilled, goal: state.goalOrders, min: awayMin };
  $('away-summary').textContent = awayMin > 0
    ? T('Your {mode} session was saved at time {tick}/{max} ({done}/{goal} orders, {min} min ago). The solo simulation paused while you were away.', vars)
    : T('Your {mode} session was saved at time {tick}/{max} ({done}/{goal} orders). The solo simulation paused while you were away.', vars);
}

/* Language changes (Settings → Language) re-render every visible text in place:
   static markup is handled by js/i18n.js, everything built in code here. */
function onLanguageChange() {
  $('btn-signin').textContent = shT().signIn;
  $('btn-invite').textContent = shT().invite;
  updateIdentityUI();
  platform.setSync(platform.sync);
  refreshTitle();
  renderHelp();
  if (session.state) refreshAll();
  if (session.tutorialStep >= 0) showTutorialStep(true);
  if ($('settings-own')) renderSettings();
  if (document.querySelector('#screen-setup.open')) renderSetupText();
  if (document.querySelector('#screen-results.open')) renderResultsText();
  if (document.querySelector('#screen-profile.open')) renderProfile();
  if (document.querySelector('#screen-leaderboard.open')) renderLeaderboard(currentBoard);
  if (document.querySelector('#screen-friends.open')) renderFriends();
  if (document.querySelector('#screen-away.open')) renderAwaySummary();
}
document.addEventListener('ms-language', onLanguageChange);
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
    session.startedAt = Date.now() - (Number.isFinite(snap.elapsedMs) ? Math.max(0, snap.elapsedMs) : 0);
    session.cmdSerial = session.log.length;
    Audio.setSeed(snap.config.seed);
    awaySummary = { state, awayMin: Math.round((Date.now() - snap.savedAt) / 60000) };
    renderAwaySummary();
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
// Post-processing passes + RoomEnvironment (same three.js revision, vendor/three/addons/).
// Loaded after first paint; if any module fails the game renders without post and says so.
let gfxAddons = null, gfxAddonsFailed = false;
function rendererOpts() {
  let mobile = false;
  try { mobile = navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches; } catch { mobile = false; }
  return { gfx: GFX, addons: gfxAddons, postFailed: gfxAddonsFailed, mobile };
}
async function loadGfxAddons() {
  try {
    const mods = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/ShaderPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
      import('three/addons/postprocessing/GTAOPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/SMAAPass.js'),
      import('three/addons/postprocessing/FXAAPass.js'),
      import('three/addons/environments/RoomEnvironment.js'),
    ]);
    gfxAddons = Object.assign({}, ...mods);
  } catch {
    gfxAddonsFailed = true;
  }
  if (renderer) Render.setAddons(renderer, gfxAddons);
  if ($('gfx-summary')) gfxSummary();
}

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
    renderer = Render.create(THREE, $('gl'), rendererOpts());
    if (!renderer) gl3d = false;
  }
  if (renderer) loadGfxAddons();
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
      renderer = Render.create(THREE, $('gl'), rendererOpts()); // rebuild from CPU descriptors
      appliedGfx = null;
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
    if (document.hidden) { saveSnapshot(); platform.cloudFlush(); Audio.stop(); }
    else if (Audio.isStarted()) Audio.resume(); // music was stopped on hide; restart it on return
  });
  window.addEventListener('beforeunload', saveSnapshot);
  window.addEventListener('pagehide', () => { saveSnapshot(); platform.cloudFlush(); });

  $('btn-signin').textContent = shT().signIn;
  $('btn-invite').textContent = shT().invite;
  $('btn-signin').addEventListener('click', () => platform.signIn());
  $('btn-invite').addEventListener('click', async () => {
    const link = platform.inviteLink();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); toastShort(shT().copied); }
    catch { toastShort(shT().copyFailed); }
  });
  platform.init().then(async () => {
    if (platform.hosted) {
      // Settings KV wins over the local / cloud-save copy, key by key; then bindings.
      const [kv, b] = await Promise.all([platform.loadSettings(), platform.loadBindings(DEFAULT_BINDINGS)]);
      let tuned = false;
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (kv[k] !== undefined && kv[k] !== null) { settings[k] = kv[k]; tuned = true; }
      }
      if (tuned) { store.set('settings', settings); applySettings(); }
      platform.primeSettings(settings);
      setBindings(b);
    }
    refreshAccountButtons();
    lp.value = 100;
    $('loading').hidden = true;
    updateIdentityUI();
    refreshTitle();
    if (!tryResume()) showScreen('screen-title');
  });

  // first gesture unlocks audio
  const unlock = () => { Audio.resume(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);
}

boot();
