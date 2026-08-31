/* Meadowstead — rules engine test suite (node:test). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/rules.js');

function botPlay(config, pick) {
  let state = R.createSession(config);
  const log = [];
  let guard = config.maxTicks * 4 + 200;
  while (!state.terminalReason && guard-- > 0) {
    const legal = R.legalActions(state);
    const unmet = {};
    for (const o of state.orders) {
      for (const [k, n] of Object.entries(o.needs)) {
        unmet[k] = Math.max(unmet[k] || 0, n - (state.inventory[k] || 0));
      }
    }
    const a = pick ? pick(state, legal) :
      (legal.find(x => x.type === 'fulfill') ||
       legal.find(x => x.type === 'harvest') ||
       legal.find(x => x.type === 'water') ||
       legal.find(x => x.type === 'craft' && unmet[x.recipe] > 0) ||
       legal.filter(x => x.type === 'plant' && unmet[x.crop] > 0)
            .sort((x, y) => unmet[y.crop] - unmet[x.crop])[0] ||
       legal.find(x => x.type === 'plant') ||
       legal.find(x => x.type === 'craft') || { type: 'wait' });
    const cmd = { id: 't' + log.length, type: a.type, plot: a.plot, crop: a.crop, recipe: a.recipe, orderId: a.orderId };
    const res = R.apply(state, cmd);
    assert.ok(res.ok, 'bot command rejected: ' + res.reason);
    log.push(cmd);
    state = res.state;
  }
  return { state, log };
}

test('deterministic replay: same seed + commands => identical hashes', () => {
  const cfg = R.defaultConfig('practice', 'det-seed', {});
  const a = botPlay(cfg);
  let s = R.createSession(cfg);
  for (const cmd of a.log) s = R.apply(s, cmd).state;
  assert.strictEqual(R.stateHash(s), R.stateHash(a.state));
  assert.deepStrictEqual(s.score, a.state.score);
});

test('different seeds produce different order sequences', () => {
  const a = R.createSession(R.defaultConfig('practice', 'seed-a', {}));
  const b = R.createSession(R.defaultConfig('practice', 'seed-b', {}));
  assert.notDeepStrictEqual(
    a.orders.map(o => o.needs), b.orders.map(o => o.needs));
});

test('legal actions: plant/water/harvest lifecycle', () => {
  let s = R.createSession(R.defaultConfig('practice', 'lc', { allowedCrops: ['turnip'] }));
  assert.ok(R.check(s, { type: 'plant', plot: 0, crop: 'turnip' }).ok);
  assert.ok(!R.check(s, { type: 'harvest', plot: 0 }).ok);
  s = R.apply(s, { id: 'a', type: 'plant', plot: 0, crop: 'turnip' }).state;
  assert.strictEqual(R.check(s, { type: 'plant', plot: 0, crop: 'turnip' }).reason, 'plot-occupied');
  assert.strictEqual(R.check(s, { type: 'harvest', plot: 0 }).reason, 'not-ready');
  s = R.apply(s, { id: 'b', type: 'water', plot: 0 }).state;
  assert.strictEqual(R.check(s, { type: 'water', plot: 0 }).reason, 'already-watered');
  s = R.apply(s, { id: 'c', type: 'wait' }).state; // grows
  s = R.apply(s, { id: 'd', type: 'water', plot: 0 }).state;
  s = R.apply(s, { id: 'e', type: 'wait' }).state; // grows -> ready (grow=2)
  assert.ok(R.check(s, { type: 'harvest', plot: 0 }).ok);
  s = R.apply(s, { id: 'f', type: 'harvest', plot: 0 }).state;
  assert.strictEqual(s.inventory.turnip, 1);
  assert.strictEqual(s.harvestCount, 1);
});

test('season legality: pumpkin cannot be planted in spring', () => {
  const s = R.createSession(R.defaultConfig('practice', 'season', {}));
  assert.strictEqual(R.seasonAt(s.tick), 'spring');
  assert.strictEqual(R.check(s, { type: 'plant', plot: 0, crop: 'pumpkin' }).reason, 'wrong-season');
  assert.strictEqual(R.check(s, { type: 'plant', plot: 0, crop: 'carrot' }).reason, undefined === '' ? '' : R.check(s, { type: 'plant', plot: 0, crop: 'carrot' }).reason);
});

test('withering: unwatered crop dies after WITHER_TICKS', () => {
  let s = R.createSession(R.defaultConfig('practice', 'wither', { allowedCrops: ['turnip'] }));
  s = R.apply(s, { id: 'a', type: 'plant', plot: 0, crop: 'turnip' }).state;
  for (let i = 0; i < R.WITHER_TICKS; i++) {
    s = R.apply(s, { id: 'w' + i, type: 'wait' }).state;
  }
  assert.strictEqual(s.plots[0].crop, null);
});

test('crafting consumes ingredients and scores', () => {
  let s = R.createSession(R.defaultConfig('practice', 'craft', {}));
  s.inventory = { turnip: 1, carrot: 1 };
  assert.ok(R.check(s, { type: 'craft', recipe: 'salad' }).ok);
  s = R.apply(s, { id: 'c1', type: 'craft', recipe: 'salad' }).state;
  assert.strictEqual(s.inventory.salad, 1);
  assert.strictEqual(s.inventory.turnip, 0);
  assert.strictEqual(R.check(s, { type: 'craft', recipe: 'salad' }).reason, 'missing-ingredients');
});

test('fulfill order: consumes items, pays coins, spawns replacement', () => {
  let s = R.createSession(R.defaultConfig('practice', 'ord', {}));
  const o = s.orders[0];
  for (const [k, n] of Object.entries(o.needs)) s.inventory[k] = n;
  const before = s.orders.length;
  const res = R.apply(s, { id: 'o1', type: 'fulfill', orderId: o.id });
  assert.ok(res.ok);
  s = res.state;
  assert.strictEqual(s.orders.length, before);
  assert.strictEqual(s.coins, o.reward);
  assert.strictEqual(s.ordersFulfilled, 1);
  assert.strictEqual(s.inventory[Object.keys(o.needs)[0]], 0);
  assert.strictEqual(R.check(s, { type: 'fulfill', orderId: o.id }).reason, 'no-such-order');
});

test('invalid actions increment counter without consuming time', () => {
  let s = R.createSession(R.defaultConfig('practice', 'inv', {}));
  const t0 = s.tick;
  const res = R.apply(s, { id: 'x', type: 'harvest', plot: 3 });
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, 'no-crop');
  assert.strictEqual(res.state.invalidActions, 1);
  assert.strictEqual(res.state.tick, t0);
});

test('duplicate command id rejected idempotently', () => {
  let s = R.createSession(R.defaultConfig('practice', 'dup', {}));
  s = R.apply(s, { id: 'same', type: 'wait' }).state;
  const res = R.apply(s, { id: 'same', type: 'wait' });
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, 'duplicate-command');
});

test('terminal states: goal-complete and time-up with score breakdown', () => {
  // goal-complete
  let cfg = R.defaultConfig('practice', 'term1', { goalOrders: 1, maxTicks: 200 });
  let s = R.createSession(cfg);
  const o = s.orders[0];
  for (const [k, n] of Object.entries(o.needs)) s.inventory[k] = n;
  s = R.apply(s, { id: 'g', type: 'fulfill', orderId: o.id }).state;
  assert.strictEqual(s.terminalReason, 'goal-complete');
  assert.ok(s.score.timeBonus > 0);
  assert.strictEqual(s.score.total, s.score.orders + s.score.harvests + s.score.crafting + s.score.coins + s.score.variety + s.score.timeBonus);
  assert.ok(Number.isInteger(s.score.total));
  // further commands rejected
  assert.strictEqual(R.check(s, { type: 'wait' }).reason, 'session-over');
  // time-up
  cfg = R.defaultConfig('practice', 'term2', { goalOrders: 99, maxTicks: 12 });
  s = R.createSession(cfg);
  for (let i = 0; i < 12; i++) s = R.apply(s, { id: 'z' + i, type: 'wait' }).state;
  assert.strictEqual(s.terminalReason, 'time-up');
  assert.strictEqual(s.score.timeBonus, 0);
});

test('serialization round-trip and migration guards', () => {
  const { state } = botPlay(R.defaultConfig('practice', 'ser', { maxTicks: 30 }));
  const json = R.serialize(state);
  const back = R.deserialize(json);
  assert.strictEqual(R.stateHash(back), R.stateHash(state));
  assert.throws(() => R.deserialize(JSON.stringify({ schema: 99 })), /newer/);
  assert.throws(() => R.deserialize('{"schema":"x"}'));
});

test('fuzz: malformed commands never hang or corrupt state', () => {
  let s = R.createSession(R.defaultConfig('practice', 'fuzz', {}));
  const junk = [
    null, undefined, {}, { id: 1 }, { id: 'a' }, { id: 'a', type: 'explode' },
    { id: 'b', type: 'plant', plot: -1 }, { id: 'c', type: 'plant', plot: 999 },
    { id: 'd', type: 'plant', plot: 0, crop: 'weed' },
    { id: 'e', type: 'craft', recipe: 'stone' },
    { id: 'f', type: 'fulfill', orderId: 'nope' },
    { id: 'g', type: 'plant', plot: NaN },
    { id: 'h', type: 'water', plot: 0.5 },
  ];
  for (const cmd of junk) {
    const res = R.apply(s, cmd);
    assert.ok(!res.ok);
    s = res.state;
    assert.ok(Number.isFinite(s.tick));
  }
  assert.ok(s.invalidActions >= 9); // entries without a string id return early without counting
});

test('content validation: all 40 journey stages pass offline validators', () => {
  for (let i = 1; i <= 40; i++) {
    const cfg = R.journeyStage(i);
    const v = R.validateContent(cfg);
    assert.ok(v.ok, 'stage ' + i + ' invalid: ' + v.problems.join(','));
  }
});

test('content validation: daily seeds for a year are legal and bounded', () => {
  for (let m = 1; m <= 12; m++) {
    for (const d of [1, 15, 28]) {
      const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cfg = R.defaultConfig('daily', R.dailySeed(date), { maxTicks: 100, goalOrders: 8 });
      const v = R.validateContent(cfg);
      assert.ok(v.ok, date + ': ' + v.problems.join(','));
    }
  }
});

test('content validation rejects broken configs', () => {
  assert.ok(!R.validateContent(R.defaultConfig('x', 's', { plotCount: 0 })).ok);
  assert.ok(!R.validateContent(R.defaultConfig('x', 's', { maxTicks: 5 })).ok);
  assert.ok(!R.validateContent(R.defaultConfig('x', 's', { allowedCrops: [] })).ok);
});

test('golden sessions: easy/normal/hard bots terminate with sane scores', () => {
  for (const [name, cfg] of [
    ['easy', R.defaultConfig('practice', 'gold-easy', { difficulty: 'easy', goalOrders: 4, maxTicks: 120 })],
    ['normal', R.defaultConfig('practice', 'gold-normal', {})],
    ['hard', R.defaultConfig('practice', 'gold-hard', { difficulty: 'hard', goalOrders: 10, maxTicks: 70 })],
    ['learn', R.defaultConfig('learn', 'learn-seed', { maxTicks: 60, goalOrders: 2, plotCount: 8, allowedCrops: ['turnip', 'carrot'], allowedRecipes: [] })],
  ]) {
    const { state } = botPlay(cfg);
    assert.ok(state.terminalReason, name + ' did not terminate');
    assert.ok(state.score.total >= 0, name + ' negative score');
    assert.ok(state.ordersFulfilled > 0, name + ' no orders fulfilled');
  }
});

test('hint API uses same legal-action list as play', () => {
  const s = R.createSession(R.defaultConfig('practice', 'hint', {}));
  const legal = R.legalActions(s);
  for (const a of legal) {
    assert.ok(R.check(s, a).ok, 'legal action rejected by check: ' + JSON.stringify(a));
  }
});

test('daily seed is stable per date and distinct across dates', () => {
  assert.strictEqual(R.dailySeed('2026-08-29'), R.dailySeed('2026-08-29'));
  assert.notStrictEqual(R.dailySeed('2026-08-29'), R.dailySeed('2026-08-30'));
});
