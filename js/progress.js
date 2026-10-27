/* Meadowstead — the save document, pure (node tests import it; the engine
   client imports it through native/platform.ts).

   The game's save (starhermit:storage `saves`, schema 1) is
   { v: 1, progress, snapshot }: the progress (journey stage, mastery XP,
   lifetime coins, achievements, daily streak and completed dailies, friends,
   the local board) and the round in progress. The browser build kept the same
   pieces in localStorage and wrote { schema: 1, savedAt, progress, settings,
   snapshot } to the account's game:<slug> cloud slot through the JS SDK; the
   runtime shows that slot as a foreign save, read here once. */

export const DEFAULT_PROGRESS = {
  schema: 1, journeyStage: 1, masteryXp: 0, lifetimeCoins: 0,
  achievements: {}, dailyStreak: 0, lastDailyDate: null, completedDailies: {},
  tutorialDone: false, friends: [], localBoard: [],
};
export const defaultProgress = () => JSON.parse(JSON.stringify(DEFAULT_PROGRESS));

/* Merge another device's progress with this one: the further journey stage and
   larger counters win, achievements / dailies / friends are united, and the
   local board keeps the best 50 runs from both. Nothing either side earned is lost. */
export function mergeProgress(local, remote) {
  const a = local || {}, b = remote || {};
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const out = Object.assign({}, b, a);
  out.journeyStage = Math.max(num(a.journeyStage) || 1, num(b.journeyStage) || 1);
  out.masteryXp = Math.max(num(a.masteryXp), num(b.masteryXp));
  out.lifetimeCoins = Math.max(num(a.lifetimeCoins), num(b.lifetimeCoins));
  out.craftTotal = Math.max(num(a.craftTotal), num(b.craftTotal));
  out.tutorialDone = !!(a.tutorialDone || b.tutorialDone);
  out.achievements = Object.assign({}, b.achievements || {}, a.achievements || {});
  for (const [k, t] of Object.entries(b.achievements || {})) if (out.achievements[k] > t) out.achievements[k] = t; // earliest unlock
  out.completedDailies = Object.assign({}, b.completedDailies || {});
  for (const [d, sc] of Object.entries(a.completedDailies || {})) out.completedDailies[d] = Math.max(num(sc), num(out.completedDailies[d]));
  // The streak belongs to whichever side played the latest daily.
  const newer = String(b.lastDailyDate || '') > String(a.lastDailyDate || '') ? b : a;
  out.lastDailyDate = newer.lastDailyDate || null;
  out.dailyStreak = a.lastDailyDate === b.lastDailyDate ? Math.max(num(a.dailyStreak), num(b.dailyStreak)) : num(newer.dailyStreak);
  out.friends = [...new Set([...(b.friends || []), ...(a.friends || [])])];
  const seen = new Set();
  out.localBoard = [...(a.localBoard || []), ...(b.localBoard || [])].filter((row) => {
    const id = [row.name, row.score, row.mode, row.seed, row.when].join('|');
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((x, y) => y.score - x.score).slice(0, 50);
  return out;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** A progress object read from anywhere, completed with the defaults. */
export function readProgress(p) {
  return isObj(p) ? Object.assign(defaultProgress(), p) : defaultProgress();
}
/** A round snapshot ({ schema: 1, config, log, state, ranked, … }) or null. */
export function readSnapshot(s) {
  return isObj(s) && s.schema === 1 && typeof s.state === 'string' && isObj(s.config) ? s : null;
}
/** The save document for progress and an optional snapshot. */
export function saveData(progress, snapshot) {
  return { v: 1, progress: readProgress(progress), snapshot: readSnapshot(snapshot) };
}
/** Reads a save document (this game's or anything else) as { progress, snapshot }. */
export function readSave(data) {
  const d = isObj(data) ? data : {};
  return { progress: readProgress(d.progress), snapshot: readSnapshot(d.snapshot) };
}
/** Two devices' saves merged: progress united, this device's round kept (else the other's). */
export function mergeSaves(local, remote) {
  const a = readSave(local), b = readSave(remote);
  return saveData(mergeProgress(a.progress, b.progress), a.snapshot || b.snapshot);
}
export const sameData = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/* ---- the game's own options (engine settings game.<key>) ---- */
export const DEFAULT_OPTIONS = { palette: 'default', leftHanded: false, haptics: true, captions: true };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
export const PALETTE_IDS = ['default', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'];
/** The browser build's settings object keys (its settings KV and the cloud doc's `settings`). */
export const BROWSER_KEYS = ['volumes', 'muted', 'quality', 'gfx', 'reducedMotion', 'highContrast', 'palette', 'textScale',
  'leftHanded', 'holdToConfirm', 'timingAssist', 'haptics', 'captions', 'tutorialDone', 'cameraShake'];
/** The valid game options in a settings object. */
export function pickOptions(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  if (PALETTE_IDS.includes(raw.palette)) out.palette = raw.palette;
  for (const k of ['leftHanded', 'haptics', 'captions']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/** The browser build's cloud document (the foreign save's text): its progress, round and options, or null. */
export function readForeign(text) {
  let doc;
  try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!isObj(doc) || (!isObj(doc.progress) && !isObj(doc.snapshot))) return null;
  const options = pickOptions(doc.settings);
  const progress = readProgress(doc.progress);
  if (isObj(doc.settings) && doc.settings.tutorialDone === true) progress.tutorialDone = true;
  return { progress, snapshot: readSnapshot(doc.snapshot), options };
}
