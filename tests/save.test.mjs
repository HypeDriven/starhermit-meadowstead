// The save document (js/progress.js): the two-device merge the conflict
// handler uses, the browser build's cloud document (the foreign save) read
// once, and the game options picked from old settings. Signed-in paths can't
// be live-tested here, so their logic is covered by these units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProgress, mergeSaves, readForeign, readSave, saveData, pickOptions, defaultProgress, BROWSER_KEYS, OPTION_KEYS,
} from '../js/progress.js';
import R from '../js/rules.js';

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

function snapshot(seed) {
  const config = R.defaultConfig('practice', seed, {});
  return { schema: 1, savedAt: 5, config, log: [], state: R.serialize(R.createSession(config)), ranked: false, elapsedMs: 0 };
}

test('mergeSaves unites progress and keeps this device\'s round, else the other\'s', () => {
  const a = saveData({ ...defaultProgress(), journeyStage: 3 }, snapshot('here'));
  const b = saveData({ ...defaultProgress(), journeyStage: 7, achievements: { first_order: 9 } }, snapshot('there'));
  const m = mergeSaves(a, b);
  assert.equal(m.progress.journeyStage, 7);
  assert.deepEqual(m.progress.achievements, { first_order: 9 });
  assert.equal(m.snapshot.config.seed, 'here');
  assert.equal(mergeSaves(saveData(defaultProgress(), null), b).snapshot.config.seed, 'there');
  // Garbage on either side reads as defaults.
  assert.equal(mergeSaves(null, 'junk').progress.journeyStage, 1);
  assert.equal(readSave({ progress: 3, snapshot: { schema: 2 } }).snapshot, null);
});

test('the browser build\'s cloud document migrates: progress, round, options, tutorial', () => {
  const doc = {
    schema: 1, savedAt: 1760000000000,
    progress: { schema: 1, journeyStage: 12, masteryXp: 900, lifetimeCoins: 4000, achievements: { first_harvest: 1 },
      dailyStreak: 2, lastDailyDate: '2026-10-10', completedDailies: { '2026-10-10': 300 }, tutorialDone: false, friends: ['Ann'], localBoard: [] },
    settings: { volumes: { music: 0.2 }, muted: true, palette: 'tritanopia', leftHanded: true, haptics: false, captions: 'yes',
      holdToConfirm: true, tutorialDone: true, gfx: { preset: 'high' } },
    snapshot: snapshot('practice-77'),
  };
  const f = readForeign(JSON.stringify(doc));
  assert.equal(f.progress.journeyStage, 12);
  assert.equal(f.progress.tutorialDone, true);
  assert.equal(f.snapshot.config.seed, 'practice-77');
  assert.deepEqual(f.options, { palette: 'tritanopia', leftHanded: true, haptics: false });
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign(JSON.stringify({ hello: 1 })), null);
  // Every old settings key the account KV may hold is known (they are removed after the migration).
  for (const k of OPTION_KEYS) assert.ok(BROWSER_KEYS.includes(k), k);
  assert.deepEqual(pickOptions({ palette: 'nope', captions: false }), { captions: false });
});
