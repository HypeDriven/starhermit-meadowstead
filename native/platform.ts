// The game's data and the StarHermit platform, on the runtime's modules
// (the browser build's js/platform.js over starhermit-sdk.js):
// - the progress and the round in progress are the game's save
//   (starhermit:storage `saves`, schema 1, js/progress.js saveData: on the
//   device and in the player's cloud slot); two devices' saves merge on a
//   conflict (js/progress.js mergeSaves: the browser build's saveconflict
//   merge); the slot the browser build wrote through the JS SDK's saveJSON
//   (game:<slug>) shows as foreign: it is merged in and replaced once, its
//   round adopted when this device has none, its game options adopted where
//   this game has not set them;
// - the game's own options (colour palette, left-handed tray, haptics,
//   captions) are engine `settings` (game.<key>, synced with the account); the
//   browser build's values in the account's settings KV are migrated, then all
//   its KV keys removed (sound, graphics, reduced motion, high contrast and
//   larger text are the runtime's Options now);
// - the anonymous funnel log stays in the device's key/value storage, as it
//   stayed in localStorage;
// - the player, the invite link, the platform's clock for the Daily, the
//   friends list, the high-score board, and posting a finished ranked run's
//   total through score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank on the board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, friends as platformFriends, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, serverNow,
  serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as P from "../js/progress.js";

export interface Progress {
  schema: number; journeyStage: number; masteryXp: number; lifetimeCoins: number; craftTotal?: number;
  achievements: Record<string, number>; dailyStreak: number; lastDailyDate: string | null; completedDailies: Record<string, number>;
  tutorialDone: boolean; friends: string[];
  localBoard: { name: string; score: number; mode: string; seed: string; when: number; board: string }[];
}
export interface Snapshot {
  schema: 1; savedAt: number; config: unknown; log: unknown[]; state: string; ranked: boolean; elapsedMs: number;
}
export interface Options { palette: string; leftHanded: boolean; haptics: boolean; captions: boolean }
type Key = keyof Options;
interface SaveDoc { v: 1; progress: Progress; snapshot: Snapshot | null }
const Save = P as unknown as {
  DEFAULT_OPTIONS: Options; OPTION_KEYS: Key[]; BROWSER_KEYS: string[]; PALETTE_IDS: string[];
  defaultProgress(): Progress;
  pickOptions(raw: unknown): Partial<Options>;
  saveData(progress: Progress, snapshot: Snapshot | null): SaveDoc;
  readSave(data: unknown): { progress: Progress; snapshot: Snapshot | null };
  mergeSaves(local: unknown, remote: unknown): SaveDoc;
  mergeProgress(a: Progress, b: Progress): Progress;
  sameData(a: unknown, b: unknown): boolean;
  readForeign(text: string | null): { progress: Progress; snapshot: Snapshot | null; options: Partial<Options> } | null;
};
export const PALETTE_IDS = Save.PALETTE_IDS;

// --- the save ------------------------------------------------------------------------------
export let progress: Progress = Save.defaultProgress();
let snapshot: Snapshot | null = null;
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(Save.saveData(progress, snapshot) as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Saves progress (device at once, the account debounced by the runtime). */
export function saveProgress(): void { write(); }
export function getSnapshot(): Snapshot | null { return snapshot; }
/** Keeps (or with null clears) the round in progress in the save. */
export function setSnapshot(s: Snapshot | null): void {
  if (!s && !snapshot) return;
  snapshot = s;
  write();
}
/** Merges another document into the live one; whether anything changed (then saved). */
function adopt(other: unknown): boolean {
  const mine = Save.saveData(progress, snapshot);
  const next = Save.mergeSaves(mine, other);
  if (Save.sameData(next, mine)) return false;
  progress = next.progress;
  snapshot = next.snapshot;
  write();
  return true;
}
saves.onConflict((localSave, remote) => ({ merged: Save.mergeSaves(localSave?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud document: merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const f = Save.readForeign(old.text);
  let changed = false;
  if (f) {
    changed = adopt({ v: 1, progress: f.progress, snapshot: f.snapshot });
    for (const [k, v] of Object.entries(f.options)) adoptOption(k as Key, v);
  }
  write({ replaceForeign: true });
  if (changed) merged();
}

/** For the sync chip: local (a guest) | saving | synced | offline. */
export function syncState(): "local" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- device-only storage (the anonymous funnel log) ----------------------------------------------
export function deviceGet(key: string): JsonValue | null { try { return storage.getJson(key); } catch { return null; } }
export function deviceSet(key: string, value: JsonValue): void { try { storage.setJson(key, value); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); } }

// --- the game's options --------------------------------------------------------------------
export const options: Options = { ...Save.DEFAULT_OPTIONS };
const KEYS = Save.OPTION_KEYS;
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function check<K extends Key>(key: K, v: unknown): Options[K] | undefined { return Save.pickOptions({ [key]: v })[key] as Options[K] | undefined; }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = check(key, v);
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = check(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
// The browser build patched its whole settings object into the account's settings KV key by key (plus the
// language helper's ui.language): the game's options carry over (unless set here since), then all are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if ((KEYS as string[]).includes(key)) adoptOption(key as Key, store.legacy(key));
  if (keys.includes("tutorialDone") && store.legacy("tutorialDone") === true && !progress.tutorialDone) { progress.tutorialDone = true; write(); }
  for (const key of keys) if (Save.BROWSER_KEYS.includes(key) || key.startsWith("ui.")) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const r = Save.readSave(cur?.data ?? null);
  progress = r.progress;
  snapshot = r.snapshot;
  for (const k of KEYS) readOption(k);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readOption(key as Key);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
/** The player's name (nickname), or "You" for a guest (main.js platform.displayName). */
export function displayName(fallback: string): string { return player()?.displayName || fallback; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Today's UTC date (YYYY-MM-DD) by that clock: the Daily's and the Score Chase's seed. */
export function utcDate(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- friends -------------------------------------------------------------------------------
export interface FriendRow { userId: string; name: string; online: boolean }
const names = new Map<string, string>();
async function nameFor(userId: string, fallback: string): Promise<string> {
  const known = names.get(userId);
  if (known) return known;
  try { const p = await profile(userId); names.set(userId, p.displayName); return p.displayName; } catch { return fallback; }
}
/** The platform account's friends with their names and presence (signed in only). */
export async function friendList(): Promise<FriendRow[]> {
  if (!player()) return [];
  const list = await platformFriends.list();
  return Promise.all(list.map(async (f) => ({ userId: f.userId, name: await nameFor(f.userId, f.username), online: f.online })));
}

// --- leaderboards --------------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { userId: string; name: string; score: number }
/** The platform board's top 20 (friendsOnly: the player's and friends' rows); [] when there is no board. */
export async function boardEntries(friendsOnly: boolean): Promise<BoardRow[]> {
  const b = await highScoreBoard();
  if (!b) return [];
  const r = await leaderboards.entries(b.id, friendsOnly ? { friendsOnly: true, pageSize: 100 } : { pageSize: 20 });
  return r.items.slice(0, 20).map((e) => ({ userId: e.userId, name: e.displayName || e.username, score: e.score ?? 0 }));
}

/** Signed in only: post a finished ranked run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
