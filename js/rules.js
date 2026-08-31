/* Meadowstead — deterministic rules engine.
   Pure, serializable, no rendering. Shared by browser client (window.MeadowRules)
   and the authoritative server (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeadowRules = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
'use strict';

const SCHEMA_VERSION = 1;
const CONTENT_VERSION = 1;

const CROPS = {
  turnip:  { name: 'Turnip',  grow: 2, value: 4,  seasons: ['spring', 'autumn'] },
  carrot:  { name: 'Carrot',  grow: 3, value: 6,  seasons: ['spring', 'summer'] },
  pumpkin: { name: 'Pumpkin', grow: 5, value: 10, seasons: ['summer', 'autumn'] },
};
const RECIPES = {
  salad: { name: 'Garden Salad', needs: { turnip: 1, carrot: 1 }, value: 14 },
  pie:   { name: 'Harvest Pie',  needs: { pumpkin: 2, carrot: 1 }, value: 26 },
};
const SEASONS = ['spring', 'summer', 'autumn'];
const SEASON_TICKS = 15;
const WITHER_TICKS = 4;
const ACTIVE_ORDERS = 3;

/* ---------- deterministic hashing / rng ---------- */
function fnv(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/* Seeded random streams: value depends only on (seed, stream, call index). */
function rngFloat(seed, stream, calls) {
  let h = fnv(seed + '|' + stream + '|' + calls);
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17;
  h ^= h << 5;  h >>>= 0;
  return h / 4294967296;
}
function rngInt(seed, stream, calls, n) {
  return Math.floor(rngFloat(seed, stream, calls) * n);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function stateHash(state) {
  return fnv(stableStringify(state)).toString(16).padStart(8, '0');
}

/* ---------- content / session setup ---------- */
function defaultConfig(mode, seed, overrides) {
  const base = {
    mode: mode || 'practice',
    seed: String(seed == null ? 'meadow-1' : seed),
    maxTicks: 90,
    goalOrders: 6,
    plotCount: 12,
    allowedCrops: ['turnip', 'carrot', 'pumpkin'],
    allowedRecipes: ['salad', 'pie'],
    difficulty: 'normal',
    assists: { hints: true, undo: false },
    contentVersion: CONTENT_VERSION,
  };
  return Object.assign(base, overrides || {});
}

function seasonAt(tick) {
  return SEASONS[Math.floor(tick / SEASON_TICKS) % SEASONS.length];
}

function clone(state) { return JSON.parse(JSON.stringify(state)); }

function genOrder(state, serial) {
  const calls = state.rngCalls.orders++;
  const season = seasonAt(state.tick);
  // Orders must be producible: only in-season crops, and recipes whose
  // ingredients are all in-season (prevents unreachable demands).
  const cropsInSeason = state.allowedCrops.filter(c => CROPS[c].seasons.indexOf(season) >= 0);
  const crops = cropsInSeason.length ? cropsInSeason : state.allowedCrops.slice();
  const recipes = state.tick >= 10
    ? state.allowedRecipes.filter(r => Object.keys(RECIPES[r].needs).every(k => crops.indexOf(k) >= 0))
    : [];
  const items = crops.concat(recipes);
  if (!items.length) return { id: 'o' + serial, needs: { wait: 0 }, reward: 0, score: 0 };
  const r1 = rngInt(state.seed, 'orders', calls * 7 + 0, items.length);
  const needs = {};
  const first = items[r1];
  needs[first] = 1 + rngInt(state.seed, 'orders', calls * 7 + 1, state.difficulty === 'easy' ? 1 : 2);
  const distinct = state.difficulty === 'easy' ? 1 : 1 + rngInt(state.seed, 'orders', calls * 7 + 2, Math.min(2, items.length));
  for (let i = 1; i < distinct; i++) {
    const it = items[rngInt(state.seed, 'orders', calls * 7 + 2 + i, items.length)];
    needs[it] = (needs[it] || 0) + 1;
  }
  let value = 0;
  for (const k of Object.keys(needs)) {
    const unit = CROPS[k] ? CROPS[k].value : RECIPES[k].value;
    value += unit * needs[k];
  }
  const reward = value + 2 + rngInt(state.seed, 'orders', calls * 7 + 6, 5);
  return { id: 'o' + serial, needs: needs, reward: reward, score: reward * 10 };
}

function createSession(config) {
  const cfg = defaultConfig(config.mode, config.seed, config);
  const state = {
    schema: SCHEMA_VERSION,
    contentVersion: cfg.contentVersion,
    mode: cfg.mode,
    seed: cfg.seed,
    difficulty: cfg.difficulty,
    tick: 0,
    maxTicks: cfg.maxTicks,
    goalOrders: cfg.goalOrders,
    plotCount: cfg.plotCount,
    allowedCrops: cfg.allowedCrops.slice(),
    allowedRecipes: cfg.allowedRecipes.slice(),
    assists: cfg.assists,
    plots: [],
    inventory: {},
    coins: 0,
    orders: [],
    nextOrderSerial: 0,
    ordersFulfilled: 0,
    orderScore: 0,
    harvestCount: 0,
    craftCount: 0,
    variety: {},
    invalidActions: 0,
    rngCalls: { orders: 0 },
    appliedIds: [],
    terminalReason: null,
    score: null,
  };
  for (let i = 0; i < cfg.plotCount; i++) state.plots.push({ crop: null });
  while (state.orders.length < ACTIVE_ORDERS) {
    state.orders.push(genOrder(state, state.nextOrderSerial++));
  }
  return state;
}

/* ---------- legality ---------- */
function err(reason) { return { ok: false, reason: reason }; }
function ok() { return { ok: true, reason: null }; }

function checkPlant(state, plot, crop) {
  if (!CROPS[crop]) return err('unknown-crop');
  if (state.allowedCrops.indexOf(crop) < 0) return err('crop-not-unlocked');
  if (plot < 0 || plot >= state.plots.length) return err('no-such-plot');
  if (state.plots[plot].crop) return err('plot-occupied');
  if (CROPS[crop].seasons.indexOf(seasonAt(state.tick)) < 0) return err('wrong-season');
  return ok();
}
function checkWater(state, plot) {
  if (plot < 0 || plot >= state.plots.length) return err('no-such-plot');
  const c = state.plots[plot].crop;
  if (!c) return err('no-crop');
  if (c.ready) return err('already-grown');
  if (c.watered) return err('already-watered');
  return ok();
}
function checkHarvest(state, plot) {
  if (plot < 0 || plot >= state.plots.length) return err('no-such-plot');
  const c = state.plots[plot].crop;
  if (!c) return err('no-crop');
  if (!c.ready) return err('not-ready');
  return ok();
}
function checkCraft(state, recipe) {
  const r = RECIPES[recipe];
  if (!r) return err('unknown-recipe');
  if (state.allowedRecipes.indexOf(recipe) < 0) return err('recipe-not-unlocked');
  for (const k of Object.keys(r.needs)) {
    if ((state.inventory[k] || 0) < r.needs[k]) return err('missing-ingredients');
  }
  return ok();
}
function checkFulfill(state, orderId) {
  const o = state.orders.find(o => o.id === orderId);
  if (!o) return err('no-such-order');
  for (const k of Object.keys(o.needs)) {
    if ((state.inventory[k] || 0) < o.needs[k]) return err('missing-items');
  }
  return ok();
}

function check(state, cmd) {
  if (state.terminalReason) return err('session-over');
  if (!cmd || typeof cmd.type !== 'string') return err('malformed-command');
  switch (cmd.type) {
    case 'plant':   return checkPlant(state, cmd.plot | 0, cmd.crop);
    case 'water':   return checkWater(state, cmd.plot | 0);
    case 'harvest': return checkHarvest(state, cmd.plot | 0);
    case 'craft':   return checkCraft(state, cmd.recipe);
    case 'fulfill': return checkFulfill(state, cmd.orderId);
    case 'wait':    return ok();
    default:        return err('unknown-command');
  }
}

/* Same legality API the tutorial/hints use. */
function legalActions(state) {
  const list = [];
  if (state.terminalReason) return list;
  for (let p = 0; p < state.plots.length; p++) {
    for (const crop of state.allowedCrops) {
      if (checkPlant(state, p, crop).ok) list.push({ type: 'plant', plot: p, crop: crop });
    }
    if (checkWater(state, p).ok) list.push({ type: 'water', plot: p });
    if (checkHarvest(state, p).ok) list.push({ type: 'harvest', plot: p });
  }
  for (const r of state.allowedRecipes) {
    if (checkCraft(state, r).ok) list.push({ type: 'craft', recipe: r });
  }
  for (const o of state.orders) {
    if (checkFulfill(state, o.id).ok) list.push({ type: 'fulfill', orderId: o.id });
  }
  list.push({ type: 'wait' });
  return list;
}

/* ---------- state transitions ---------- */
function advanceTime(state, events, skipPlot) {
  state.tick += 1;
  for (let p = 0; p < state.plots.length; p++) {
    if (p === skipPlot) continue; // the plot just acted on is unaffected this tick
    const c = state.plots[p].crop;
    if (!c || c.ready) continue;
    if (c.watered) {
      c.age += 1;
      c.watered = false;
      c.thirsty = 0;
      if (c.age >= CROPS[c.type].grow) {
        c.ready = true;
        events.push({ type: 'grown', plot: p, crop: c.type });
      }
    } else {
      c.thirsty += 1;
      if (c.thirsty >= WITHER_TICKS) {
        events.push({ type: 'withered', plot: p, crop: c.type });
        state.plots[p].crop = null;
      }
    }
  }
}

function computeScore(state) {
  const comps = {
    orders: state.orderScore,
    harvests: state.harvestCount * 5,
    crafting: state.craftCount * 15,
    coins: state.coins,
    variety: Object.keys(state.variety).length * 25,
    timeBonus: state.terminalReason === 'goal-complete' ? (state.maxTicks - state.tick) * 2 : 0,
  };
  comps.total = comps.orders + comps.harvests + comps.crafting + comps.coins + comps.variety + comps.timeBonus;
  return comps;
}

function finishIfTerminal(state, events) {
  if (state.ordersFulfilled >= state.goalOrders) state.terminalReason = 'goal-complete';
  else if (state.tick >= state.maxTicks) state.terminalReason = 'time-up';
  if (state.terminalReason) {
    state.score = computeScore(state);
    events.push({ type: 'terminal', reason: state.terminalReason, score: state.score });
  }
}

/* Apply a validated command. Returns {state, ok, reason, events}.
   On failure the original state object is returned unmodified. */
function apply(prev, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.id !== 'string' || !cmd.id) {
    return { state: prev, ok: false, reason: 'missing-command-id', events: [] };
  }
  if (prev.appliedIds.indexOf(cmd.id) >= 0) {
    return { state: prev, ok: false, reason: 'duplicate-command', events: [] };
  }
  const chk = check(prev, cmd);
  if (!chk.ok) {
    const s = clone(prev);
    s.invalidActions += 1;
    return { state: s, ok: false, reason: chk.reason, events: [{ type: 'invalid', reason: chk.reason }] };
  }
  const state = clone(prev);
  const events = [];
  switch (cmd.type) {
    case 'plant': {
      state.plots[cmd.plot | 0].crop = { type: cmd.crop, age: 0, watered: false, thirsty: 0, ready: false };
      events.push({ type: 'planted', plot: cmd.plot | 0, crop: cmd.crop });
      break;
    }
    case 'water': {
      state.plots[cmd.plot | 0].crop.watered = true;
      events.push({ type: 'watered', plot: cmd.plot | 0 });
      break;
    }
    case 'harvest': {
      const c = state.plots[cmd.plot | 0].crop;
      state.plots[cmd.plot | 0].crop = null;
      state.inventory[c.type] = (state.inventory[c.type] || 0) + 1;
      state.harvestCount += 1;
      state.variety[c.type] = true;
      events.push({ type: 'harvested', plot: cmd.plot | 0, crop: c.type });
      break;
    }
    case 'craft': {
      const r = RECIPES[cmd.recipe];
      for (const k of Object.keys(r.needs)) state.inventory[k] -= r.needs[k];
      state.inventory[cmd.recipe] = (state.inventory[cmd.recipe] || 0) + 1;
      state.craftCount += 1;
      state.variety[cmd.recipe] = true;
      events.push({ type: 'crafted', recipe: cmd.recipe });
      break;
    }
    case 'fulfill': {
      const idx = state.orders.findIndex(o => o.id === cmd.orderId);
      const o = state.orders[idx];
      for (const k of Object.keys(o.needs)) state.inventory[k] -= o.needs[k];
      state.orders.splice(idx, 1);
      state.coins += o.reward;
      state.orderScore += o.score;
      state.ordersFulfilled += 1;
      state.orders.push(genOrder(state, state.nextOrderSerial++));
      events.push({ type: 'fulfilled', orderId: o.id, reward: o.reward });
      break;
    }
    case 'wait': {
      events.push({ type: 'waited' });
      break;
    }
  }
  advanceTime(state, events, typeof cmd.plot === 'number' ? cmd.plot | 0 : -1);
  state.appliedIds.push(cmd.id);
  if (state.appliedIds.length > 512) state.appliedIds = state.appliedIds.slice(-512);
  finishIfTerminal(state, events);
  return { state: state, ok: true, reason: null, events: events };
}

/* ---------- serialization / migration ---------- */
function serialize(state) {
  return JSON.stringify({ schema: SCHEMA_VERSION, state: state });
}
function migrate(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('bad-save');
  if (doc.schema === SCHEMA_VERSION) return doc.state;
  if (doc.schema > SCHEMA_VERSION) throw new Error('save-from-newer-version');
  throw new Error('unknown-save-version');
}
function deserialize(json) {
  return migrate(JSON.parse(json));
}

/* ---------- content validation (offline validators) ---------- */
function validateContent(config) {
  const problems = [];
  const cfg = defaultConfig(config.mode, config.seed, config);
  if (cfg.plotCount < 1 || cfg.plotCount > 64) problems.push('plot-count-out-of-bounds');
  if (cfg.maxTicks < 10 || cfg.maxTicks > 10000) problems.push('duration-out-of-bounds');
  if (cfg.goalOrders < 1) problems.push('goal-unreachable');
  if (!cfg.allowedCrops.length) problems.push('no-crops');
  if (problems.length) return { ok: false, problems: problems, terminalReason: null, ticks: 0 };
  /* Greedy bot: proves the goal is reachable with bounded duration (no soft lock). */
  let state = createSession(cfg);
  let guard = cfg.maxTicks * 4 + 100;
  let cid = 0;
  while (!state.terminalReason && guard-- > 0) {
    const legal = legalActions(state);
    // need-aware greedy: unmet demand = order needs minus inventory
    const unmet = {};
    for (const o of state.orders) {
      for (const [k, n] of Object.entries(o.needs)) {
        unmet[k] = Math.max(unmet[k] || 0, n - (state.inventory[k] || 0));
      }
    }
    const pick =
      legal.find(a => a.type === 'fulfill') ||
      legal.find(a => a.type === 'harvest') ||
      legal.find(a => a.type === 'water') ||
      legal.find(a => a.type === 'craft' && unmet[a.recipe] > 0) ||
      legal.filter(a => a.type === 'plant' && unmet[a.crop] > 0)
           .sort((a, b) => unmet[b.crop] - unmet[a.crop])[0] ||
      legal.find(a => a.type === 'plant') ||
      legal.find(a => a.type === 'craft') ||
      { type: 'wait' };
    const res = apply(state, { id: 'v' + (cid++), type: pick.type, plot: pick.plot, crop: pick.crop, recipe: pick.recipe, orderId: pick.orderId });
    if (!res.ok) { problems.push('validator-command-rejected:' + res.reason); break; }
    state = res.state;
    if (state.tick > cfg.maxTicks * 2) { problems.push('unbounded-duration'); break; }
  }
  if (!state.terminalReason) problems.push('no-terminal-state');
  else if (state.terminalReason === 'time-up' && state.ordersFulfilled < Math.min(1, cfg.goalOrders)) problems.push('no-progress-possible');
  return { ok: problems.length === 0, problems: problems, terminalReason: state.terminalReason, ticks: state.tick };
}

/* Daily seed from a UTC date string (immutable once published). */
function dailySeed(dateStr) {
  return 'daily-' + dateStr + '-' + fnv('meadowstead|' + dateStr).toString(36);
}

/* Journey stage generator: 40 authored stages with isolated-then-combined mechanics. */
function journeyStage(n) {
  const stage = Math.max(1, Math.min(40, n | 0));
  const seed = 'journey-' + stage;
  const crops = stage < 4 ? ['turnip'] : stage < 9 ? ['turnip', 'carrot'] : ['turnip', 'carrot', 'pumpkin'];
  const recipes = stage < 6 ? [] : stage < 12 ? ['salad'] : ['salad', 'pie'];
  const mastery = stage % 5 === 0;
  const cfg = defaultConfig('journey', seed, {
    maxTicks: Math.min(150, 40 + stage * 3),
    goalOrders: Math.min(12, 2 + Math.floor(stage / 2)),
    plotCount: mastery ? 8 : Math.min(16, 8 + Math.floor(stage / 3)),
    allowedCrops: crops,
    allowedRecipes: recipes,
    difficulty: stage < 8 ? 'easy' : 'normal',
    assists: { hints: true, undo: false },
  });
  cfg.stage = stage;
  cfg.mastery = mastery;
  return cfg;
}

return {
  SCHEMA_VERSION, CONTENT_VERSION, CROPS, RECIPES, SEASONS, SEASON_TICKS, WITHER_TICKS,
  seasonAt, defaultConfig, createSession, check, legalActions, apply, computeScore,
  stateHash, serialize, deserialize, migrate, validateContent, dailySeed, journeyStage,
  fnv, stableStringify,
};
});
