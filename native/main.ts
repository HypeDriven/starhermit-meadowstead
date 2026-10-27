// Meadowstead on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js) are the browser build's,
// unchanged and shared with the dev server.js and the Node tests; this module
// is what its js/main.js did around them: the session (commands with their
// refusal sentences, undo in Practice and Learn, the replay log and envelope,
// the snapshot that survives a quit, the Learn tutorial steps, achievements,
// journey progress, the daily streak, the local board and posting finished
// ranked runs to the high-score board), the screen stack (title, modes, setup,
// play, pause, settings, help, leaderboards, friends, profile, results, welcome
// back) and input: the plot keys and pad buttons, the tool keys, taps, clicks
// and drags on the 3D field, and the accessible plot mirror's buttons.
import "./i18n.ts";
import {
  clipboard, frame, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences,
} from "starhermit:engine";
import { bindings, onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Rules as R, type Command, type Config, type Event, type State } from "./classic.ts";
import { account, N, plain, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

export type Screen = "title" | "modes" | "setup" | "play" | "pause" | "settings" | "help" | "leaderboard" | "friends" | "profile" | "results" | "away";
export type Tool = { type: "plant"; crop: string } | { type: "water" } | { type: "harvest" };

export const app = {
  /** The open screens, the top one showing ("play" when empty and a session runs). */
  stack: [] as Screen[],
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  drawer: null as null | "left" | "right",
  banner: null as null | { text: string; until: number },
  caption: null as null | { text: string; until: number },
  toast: null as null | { text: string; until: number },
  lastAchievement: null as string | null,
  /** The results' leaderboard line (a function: it follows a language change). */
  note: null as null | (() => string),
  tool: null as Tool | null,
  selectedPlot: -1,
  board: "global" as "global" | "daily" | "friends",
  away: null as null | { state: State; awayMin: number },
  pending: null as null | { config: Config; stage: number; date: string; difficulty: string; variant: string },
};
export const options = platform.options;
const now = (): number => frame().time;

export function screen(): Screen { return app.stack[app.stack.length - 1] ?? (session.state && !session.state.terminalReason ? "play" : "title"); }
/** main.js showScreen: opens a screen over the stack (closing any drawer). */
export function showScreen(s: Screen, focus: string | null = null): void {
  app.drawer = null;
  app.stack.push(s);
  opened(focus);
}
/** main.js backScreen: back to the previous screen, else the round, else the title. */
export function backScreen(): void {
  app.stack.pop();
  if (!app.stack.length && !(session.state && !session.state.terminalReason)) app.stack.push("title");
  opened(null);
}
/** Replaces the whole stack with one screen ("play": the round). */
export function goTo(s: Screen, focus: string | null = null): void {
  app.drawer = null;
  app.stack = s === "play" ? [] : [s];
  opened(focus);
}
function opened(focus: string | null): void {
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? "first";
  ui.setFocus(null);
}
export const fresh = (n = 1): boolean => frame().frame - app.openedFrame <= n;

// ------------------------------------------------------------------ text
export const ITEM_NAMES: Record<string, string> = { turnip: N("Turnip"), carrot: N("Carrot"), pumpkin: N("Pumpkin"), salad: N("Garden Salad"), pie: N("Harvest Pie") };
export const SEASON_NAMES: Record<string, string> = { spring: N("Spring"), summer: N("Summer"), autumn: N("Autumn") };
export const MODE_NAMES: Record<string, string> = { learn: N("Learn"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge"), score: N("Score Chase") };
export function itemName(k: string): string { return ITEM_NAMES[k] ? T(ITEM_NAMES[k]!) : (R.CROPS[k]?.name ?? R.RECIPES[k]?.name ?? k); }
const ERROR_TEXT: Record<string, string> = {
  "wrong-season": N("That crop does not grow in this season."),
  "plot-occupied": N("That plot already has a crop."),
  "no-crop": N("There is no crop on that plot."),
  "already-watered": N("That crop is already watered."),
  "already-grown": N("That crop is ready — harvest it instead."),
  "not-ready": N("That crop is not ready yet. Keep watering it."),
  "missing-ingredients": N("You do not have the ingredients for that recipe."),
  "missing-items": N("You do not have the items that order needs."),
  "no-such-order": N("That order is no longer available."),
  "crop-not-unlocked": N("That crop is not available in this session."),
  "recipe-not-unlocked": N("That recipe is not available in this session."),
  "session-over": N("This session has ended."),
  "duplicate-command": N("That action was already applied."),
  "undo-not-allowed": N("Undo is only available in Practice mode."),
  "nothing-to-undo": N("Nothing to undo."),
};
export function announce(text: string): void { if (text) ui.announce(text.slice(0, 600)); }
export function toast(text: string): void { app.toast = { text, until: now() + 3.2 }; }
function banner(text: string, secs: number): void { app.banner = { text, until: now() + secs }; }
const KEY_GLYPHS: Record<string, string> = { "Arrow Left": "←", "Arrow Right": "→", "Arrow Up": "↑", "Arrow Down": "↓", Escape: "Esc", Space: "␣", Slash: "?", "/": "?" };
/** main.js keysFor: an action's effective keys, e.g. "W". */
export function keysFor(action: string): string {
  let list: { device: string; label: string }[] = [];
  try { list = bindings(action) as unknown as { device: string; label: string }[]; } catch { list = []; }
  const names = list.filter((b) => b.device === "keyboard").map((b) => KEY_GLYPHS[b.label] ?? b.label);
  return [...new Set(names)].join("/") || "—";
}
export function objectiveText(): string {
  const st = session.state;
  if (!st) return "";
  return T("Fulfill {goal} orders before time runs out ({done}/{goal}).", { goal: st.goalOrders, done: st.ordersFulfilled });
}
export function scoreSoFar(st: State): number {
  if (st.score) return st.score.total;
  const s = R.computeScore({ ...st, terminalReason: st.terminalReason || "x" });
  return s.total - s.timeBonus;
}

// ------------------------------------------------------------------ achievements
export const ACHIEVEMENTS = [
  { key: "first_harvest", name: N("First Harvest"), desc: N("Harvest your first crop.") },
  { key: "first_order", name: N("Order Up"), desc: N("Fulfill your first order.") },
  { key: "crafter", name: N("Homestead Kitchen"), desc: N("Craft 10 goods in total.") },
  { key: "journey_10", name: N("Seasoned Hand"), desc: N("Complete journey stage 10.") },
  { key: "daily_streak_3", name: N("Three Dawns"), desc: N("Complete the daily challenge 3 days in a row.") },
  { key: "homestead_restored", name: N("Homestead Restored"), desc: N("Earn 5000 lifetime coins.") },
];
export const achievementName = (key: string): string => T((ACHIEVEMENTS.find((a) => a.key === key) ?? { name: key }).name);
function unlockAchievement(key: string): boolean {
  const p = platform.progress;
  if (p.achievements[key]) return false; // idempotent
  p.achievements[key] = Date.now();
  platform.saveProgress();
  audio.sfx("achievement");
  announce(T("Achievement unlocked: {name}", { name: achievementName(key) }));
  app.lastAchievement = key;
  return true;
}

// ------------------------------------------------------------------ funnel (anonymous, local only)
const sessionId = "s-" + Math.random().toString(36).slice(2, 10);
function track(event: string, data: Record<string, string | number> = {}): void {
  const buf = (platform.deviceGet("funnel") as unknown[] | null) ?? [];
  buf.push({ t: Date.now(), event, data });
  platform.deviceSet("funnel", buf.slice(-200) as never); // no telemetry endpoint exists
}

// ------------------------------------------------------------------ session
const BUILD_VERSION = "1.0.0";
export const session = {
  state: null as State | null,
  config: null as Config | null,
  undoStack: [] as string[],
  log: [] as Command[],
  startedAt: 0,
  ranked: false,
  tutorialStep: -1,
  cmdSerial: 0,
  lastSeason: null as string | null,

  start(config: Config): void {
    this.config = config;
    this.state = R.createSession(config);
    this.undoStack = [];
    this.log = [];
    this.startedAt = Date.now();
    this.cmdSerial = 0;
    this.lastSeason = null;
    this.ranked = config.mode === "daily" || config.mode === "score";
    audio.setSeed(config.seed);
    render.setDecorationSeed(config.seed);
    app.tool = null;
    app.selectedPlot = -1;
    render.setSelected(-1);
    app.lastAchievement = null;
    app.note = null;
    goTo("play");
    announce(T("Session started. {objective}", { objective: objectiveText() }));
    track("start", { mode: config.mode, seed: config.seed });
    this.tutorialStep = -1;
    if (config.mode === "learn") { this.tutorialStep = 0; showTutorialStep(); }
    refresh();
    this.snapshotSave();
  },

  command(cmd: Command): { ok: boolean; reason: string | null } {
    if (!this.state || !this.config) return { ok: false, reason: "no-session" };
    cmd.id = "c" + (++this.cmdSerial) + "-" + this.startedAt.toString(36);
    const undoable = this.config.assists && this.config.assists.undo;
    const res = R.apply(this.state, cmd);
    if (!res.ok) {
      this.state = res.state; // the invalid-action counter advances
      // The rejected command still changed state (invalidActions), so it stays in the replay log and the
      // snapshot or the authoritative hashes diverge.
      if (res.reason !== "duplicate-command" && res.reason !== "missing-command-id") this.log.push(cmd);
      audio.sfx("invalid");
      showError(res.reason ?? "");
      refresh();
      this.snapshotSave();
      return res;
    }
    if (undoable) this.undoStack.push(R.serialize(this.state));
    this.state = res.state;
    this.log.push(cmd);
    for (const ev of res.events) this.handleEvent(ev);
    if (this.tutorialStep >= 0) tutorialOnCommand(cmd);
    refresh();
    this.snapshotSave();
    if (this.state.terminalReason) this.finish();
    return res;
  },

  undo(): void {
    if (!this.config || !(this.config.assists || { undo: false }).undo) { showError("undo-not-allowed"); return; }
    const snap = this.undoStack.pop();
    if (!snap) { showError("nothing-to-undo"); return; }
    this.state = R.deserialize(snap);
    this.log.pop();
    audio.sfx("undo");
    announce(T("Undone. Back to time {tick}.", { tick: this.state.tick }));
    refresh();
    this.snapshotSave(); // otherwise a reload restores the move that was just undone
  },

  handleEvent(ev: Event): void {
    const p = platform.progress;
    switch (ev.type) {
      case "planted": audio.sfx("plant"); render.burst(ev.plot!, 0x63b34d, 8); break;
      case "watered": audio.sfx("water"); render.burst(ev.plot!, 0x5fa8e0, 8); break;
      case "harvested": audio.sfx("harvest"); render.burst(ev.plot!, 0xffe066, 12); unlockAchievement("first_harvest"); break;
      case "crafted":
        audio.sfx("craft"); p.craftTotal = (p.craftTotal || 0) + 1;
        if (p.craftTotal >= 10) unlockAchievement("crafter");
        platform.saveProgress(); break;
      case "fulfilled":
        audio.sfx("fulfill"); unlockAchievement("first_order");
        p.lifetimeCoins += ev.reward ?? 0;
        if (p.lifetimeCoins >= 5000) unlockAchievement("homestead_restored");
        platform.saveProgress(); break;
      case "grown": audio.sfx("grown"); break;
      case "withered": audio.sfx("wither"); break;
      case "terminal": audio.sfx("terminal"); break;
    }
  },

  finish(): void {
    const st = this.state!;
    const cfg = this.config!;
    const p = platform.progress;
    const score = st.score!;
    track("round_end", { mode: st.mode, score: score.total, reason: st.terminalReason ?? "" });
    // Journey progression: the stage lives on the session config (the rules do not copy it onto state).
    if (st.mode === "journey" && st.terminalReason === "goal-complete") {
      if (cfg.stage === p.journeyStage && p.journeyStage < 40) {
        p.journeyStage++;
        if (p.journeyStage > 10) unlockAchievement("journey_10");
      }
      p.masteryXp += score.total;
      platform.saveProgress();
    }
    // Daily streak.
    if (st.mode === "daily" && st.terminalReason === "goal-complete") {
      const today = platform.utcDate();
      const yesterday = new Date(platform.nowMs() - 86400000).toISOString().slice(0, 10);
      p.dailyStreak = p.lastDailyDate === yesterday ? p.dailyStreak + 1 : 1;
      p.lastDailyDate = today;
      p.completedDailies[today] = score.total;
      if (p.dailyStreak >= 3) unlockAchievement("daily_streak_3");
      platform.saveProgress();
    }
    // The replay envelope (the dev server.js validates the same shape; the local board replays it).
    const envelope = {
      schemaVersion: R.SCHEMA_VERSION, contentVersion: st.contentVersion, build: BUILD_VERSION, mode: st.mode, seed: st.seed,
      config: cfg, commands: this.log, initialHash: R.stateHash(R.createSession(cfg)), finalHash: R.stateHash(st),
      terminalReason: st.terminalReason, score, invalidActions: st.invalidActions, elapsedMs: Date.now() - this.startedAt, sessionId,
    };
    platform.setSnapshot(null);
    // Results show before the (possibly slow) ranked submission; the note fills in after.
    app.note = this.ranked ? (platform.signedIn() ? () => account().lbPosting : () => T("Submitting score…")) : null;
    showResults();
    if (!this.ranked) return;
    submitLocal(envelope);
    if (platform.signedIn()) {
      // Signed in: post the total to the StarHermit high-score board (score-script.js) and show the rank there;
      // the run also stays a personal best on the local board.
      void platform.postLeaderboard(score.total).then((r) => {
        app.note = () => (!r.posted ? account().lbNotPosted : r.rank ? account().lbRank.replace("{rank}", String(r.rank)) : account().lbPosted);
      });
      return;
    }
    app.note = () => T("Score recorded on the local board.");
  },

  snapshotSave(): void {
    if (!this.state || this.state.terminalReason || !this.config) return;
    platform.setSnapshot({
      schema: 1, savedAt: Date.now(), config: this.config, log: this.log as unknown[],
      state: R.serialize(this.state), ranked: this.ranked, elapsedMs: Math.max(0, Date.now() - this.startedAt),
    });
  },
};

interface Envelope { config: Config; commands: Command[]; finalHash: string; mode: string; seed: string }
/** Replay validation shared with the server's semantics. */
export function replayEnvelope(env: Envelope): { ok: boolean; score?: State["score"] } {
  try {
    let st = R.createSession(env.config);
    for (const cmd of env.commands) st = R.apply(st, cmd).state;
    if (R.stateHash(st) !== env.finalHash) return { ok: false };
    return { ok: true, score: st.score };
  } catch { return { ok: false }; }
}
/** The casual local board, with the plausibility check (the run must replay to its hash). */
function submitLocal(env: Envelope): void {
  const replay = replayEnvelope(env);
  if (!replay.ok || !replay.score) return;
  const p = platform.progress;
  p.localBoard.push({
    name: platform.displayName(T("You")), score: replay.score.total, mode: env.mode, seed: env.seed, when: Date.now(),
    board: env.mode === "daily" ? "daily" : "global",
  });
  p.localBoard.sort((a, b) => b.score - a.score);
  p.localBoard = p.localBoard.slice(0, 50);
  platform.saveProgress();
}

// ------------------------------------------------------------------ tutorial (Learn mode)
export const TUTORIAL_STEPS: { text: string; match: ((c: Command) => boolean) | null }[] = [
  { text: N("Welcome! Select the Turnip tool (key 1), then choose an empty plot to plant."), match: (c) => c.type === "plant" },
  { text: N("Good. Now water your crop with the Water tool (key W) on the planted plot."), match: (c) => c.type === "water" },
  { text: N("Crops grow one step each time you act, but only when watered. Keep watering until it is ready."), match: (c) => c.type === "harvest" },
  { text: N("Harvested! Check the orders on the left — grow what they ask for, then fulfill an order."), match: (c) => c.type === "fulfill" },
  { text: N("Orders pay coins and score. Crafting combines crops into valuable goods. Fulfill 2 orders to finish this lesson."), match: null },
];
export function tutorialText(): string | null {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  if (session.tutorialStep < 0 || !step) return null;
  return T("Step {n}/{total}: {text}", { n: session.tutorialStep + 1, total: TUTORIAL_STEPS.length, text: T(step.text) });
}
function showTutorialStep(): void {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  if (!step) { session.tutorialStep = -1; return; }
  announce(T(step.text));
  track("tutorial_step", { step: session.tutorialStep });
}
function tutorialOnCommand(cmd: Command): void {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  if (!step) return;
  if (step.match && step.match(cmd)) {
    session.tutorialStep++;
    showTutorialStep();
  } else if (!step.match && session.state!.ordersFulfilled >= 2) {
    session.tutorialStep++;
    showTutorialStep();
    if (session.tutorialStep >= TUTORIAL_STEPS.length) { platform.progress.tutorialDone = true; platform.saveProgress(); }
  }
}
export function skipTutorial(): void {
  session.tutorialStep = -1;
  platform.progress.tutorialDone = true;
  platform.saveProgress();
}

// ------------------------------------------------------------------ refresh, errors, hints
/** After every state change: the season cue, the 3D field, the score readout. */
function refresh(): void {
  const st = session.state;
  if (!st) return;
  const season = R.seasonAt(st.tick);
  // Season turns are a rules consequence of the tick, not a rules event: cue them here.
  if (session.lastSeason && session.lastSeason !== season) audio.sfx("season");
  session.lastSeason = season;
  render.sync(st, season);
}
function showError(reason: string): void {
  const key = ERROR_TEXT[reason];
  const text = key ? T(key) : T("Cannot do that: {reason}", { reason });
  announce(text);
  banner("⚠ " + text, 3);
}
export function showHint(): void {
  const st = session.state;
  if (!st) return;
  const legal = R.legalActions(st); // the same API as play
  const f = legal.find((a) => a.type === "fulfill");
  const w = legal.find((a) => a.type === "water");
  const h = legal.find((a) => a.type === "harvest");
  const p = legal.find((a) => a.type === "plant");
  const c = legal.find((a) => a.type === "craft");
  let hint: string;
  if (f) hint = T("You can fulfill an order right now — press its Fulfill button.");
  else if (h) hint = T("Plot {n} is ready to harvest (tool H).", { n: h.plot! + 1 });
  else if (w) hint = T("Plot {n} needs water (tool W).", { n: w.plot! + 1 });
  else if (c) hint = T("You can craft {item}.", { item: itemName(c.recipe!) });
  else if (p) hint = T("Plant a {item} on plot {n} (in season now).", { item: itemName(p.crop!), n: p.plot! + 1 });
  else hint = T("Wait (Space) to let time pass.");
  banner("💡 " + hint, 6);
  announce(T("Hint: {hint}", { hint }));
}

// ------------------------------------------------------------------ plots and tools
export function plotLabel(i: number): string {
  const st = session.state;
  const c = st?.plots[i]?.crop;
  if (!c) return T("Empty plot {n}", { n: i + 1 });
  const stTxt = c.ready ? T("ready to harvest") : c.watered ? T("watered, growing") : T("needs water ({age}/{grow})", { age: c.age, grow: R.CROPS[c.type]!.grow });
  return T("Plot {n}: {name}, {state}", { n: i + 1, name: itemName(c.type), state: stTxt });
}
export function selectPlot(i: number): void {
  app.selectedPlot = i;
  render.setSelected(i);
  const st = session.state;
  if (i >= 0 && st) {
    const c = st.plots[i]!.crop;
    const what = !c ? T("empty") : c.ready ? T("{name}, ready", { name: itemName(c.type) })
      : c.watered ? T("{name}, watered", { name: itemName(c.type) }) : T("{name}, needs water", { name: itemName(c.type) });
    announce(T("Plot {n}: {state}", { n: i + 1, state: what }));
  }
}
export function activatePlot(i: number): void {
  const st = session.state;
  if (!st || st.terminalReason) return;
  if (!app.tool) { selectPlot(i); return; }
  const cmd: Command = { type: app.tool.type, plot: i };
  if (app.tool.type === "plant") cmd.crop = app.tool.crop;
  const res = session.command(cmd);
  if (res.ok) {
    audio.sfx("click");
    if (options.haptics) { try { vibrate(10); } catch { /* unsupported */ } }
  }
}
export const TOOL_NAMES: Record<string, string> = { turnip: N("🌱 Turnip"), carrot: N("🥕 Carrot"), pumpkin: N("🎃 Pumpkin"), water: N("💧 Water"), harvest: N("🧺 Harvest") };
export function toolKey(t: Tool | null): string | null { return t ? (t.type === "plant" ? t.crop : t.type) : null; }
/** main.js setTool: picks a tool (again: puts it down). */
export function setTool(key: string | null): void {
  if (!key || toolKey(app.tool) === key) { app.tool = null; return; }
  app.tool = key === "water" || key === "harvest" ? { type: key } : { type: "plant", crop: key };
  announce(T("Tool selected: {tool}", { tool: T(TOOL_NAMES[key]!) }));
}
export function toolAllowed(key: string): boolean {
  const st = session.state;
  return !st || !(key in R.CROPS) || st.allowedCrops.includes(key);
}
export function wait(): void { if (session.state) session.command({ type: "wait" }); }
export function canUndo(): boolean { return !!session.config?.assists?.undo; }

// ------------------------------------------------------------------ screens
export function pauseGame(): void {
  if (!session.state || session.state.terminalReason) return;
  audio.sfx("pause");
  showScreen("pause", "btn-resume");
  track("pause");
}
export function resume(): void { goTo("play"); }
function showResults(): void {
  const st = session.state!;
  const s = st.score!;
  announce(T("Session over. {headline} Total score {total}.", { headline: resultsHeadline(), total: s.total }));
  goTo("results", "btn-retry");
}
export function resultsHeadline(): string {
  const st = session.state;
  if (!st) return "";
  return st.terminalReason === "goal-complete"
    ? T("Homestead goal complete with {left} time to spare!", { left: st.maxTicks - st.tick })
    : T("Time is up — {done}/{goal} orders fulfilled.", { done: st.ordersFulfilled, goal: st.goalOrders });
}
export function showNext(): boolean {
  const st = session.state;
  return !!st && st.mode === "journey" && st.terminalReason === "goal-complete" && platform.progress.journeyStage <= 40;
}
export function leave(): void { session.state = null; platform.setSnapshot(null); goTo("title", "btn-play"); }
export function restart(): void { if (session.config) session.start(session.config); }

/** main.js openSetup: the pending config for a mode, shown on the setup screen. */
export function openSetup(mode: string): void {
  const p = platform.progress;
  let cfg: Config;
  const date = platform.utcDate();
  if (mode === "learn") {
    cfg = R.defaultConfig("learn", "learn-seed", { maxTicks: 60, goalOrders: 2, plotCount: 8, allowedCrops: ["turnip", "carrot"], allowedRecipes: [], difficulty: "easy", assists: { hints: true, undo: true } });
  } else if (mode === "journey") {
    cfg = R.journeyStage(p.journeyStage);
  } else if (mode === "daily") {
    cfg = R.defaultConfig("daily", R.dailySeed(date), { maxTicks: 100, goalOrders: 8, difficulty: "normal" });
  } else if (mode === "practice") {
    cfg = R.defaultConfig("practice", "practice-" + Math.floor(Math.random() * 1e9), { assists: { hints: true, undo: true } });
  } else if (mode === "challenge") {
    cfg = R.defaultConfig("challenge", "challenge-blitz", { maxTicks: 40, goalOrders: 5, plotCount: 8, difficulty: "normal" });
  } else {
    cfg = R.defaultConfig("score", "scorechase-" + date, { maxTicks: 120, goalOrders: 10, difficulty: "hard" });
  }
  app.pending = { config: cfg, stage: p.journeyStage, date, difficulty: "normal", variant: "blitz" };
  if (screen() === "setup") app.stack.pop();
  showScreen("setup", "btn-start-session");
}
export function startPending(): void {
  const pend = app.pending;
  if (!pend) return;
  let cfg = pend.config;
  if (cfg.mode === "practice") {
    const d = pend.difficulty;
    cfg = R.defaultConfig("practice", cfg.seed, {
      difficulty: d, maxTicks: d === "easy" ? 120 : d === "hard" ? 70 : 90, goalOrders: d === "easy" ? 4 : d === "hard" ? 10 : 6,
      assists: { hints: true, undo: true },
    });
  } else if (cfg.mode === "challenge") {
    if (pend.variant === "small") cfg = R.defaultConfig("challenge", "challenge-small", { plotCount: 8, maxTicks: 90, goalOrders: 6 });
    else if (pend.variant === "nocraft") cfg = R.defaultConfig("challenge", "challenge-nocraft", { allowedRecipes: [], maxTicks: 90, goalOrders: 6 });
  }
  session.start(cfg);
}

// ------------------------------------------------------------------ the platform
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  let ok = false;
  try { clipboard.writeText(link); ok = true; } catch { ok = false; }
  toast(ok ? account().copied : account().copyFailed);
}
export function copySeed(): void {
  const seed = R.dailySeed(platform.utcDate());
  let ok = false;
  try { clipboard.writeText(seed); ok = true; } catch { ok = false; }
  const text = ok ? T("Seed copied: {seed}", { seed }) : T("Seed: {seed}", { seed });
  announce(text);
  toast(text);
}

/** main.js tryResume: a saved round opens behind "Welcome back". */
function tryResume(): boolean {
  const snap = platform.getSnapshot();
  if (!snap) return false;
  try {
    const state = R.deserialize(snap.state);
    if (state.terminalReason) { platform.setSnapshot(null); return false; }
    session.config = snap.config as Config;
    session.state = state;
    session.log = (snap.log || []) as Command[];
    session.ranked = !!snap.ranked;
    session.undoStack = [];
    session.startedAt = Date.now() - (Number.isFinite(snap.elapsedMs) ? Math.max(0, snap.elapsedMs) : 0);
    session.cmdSerial = session.log.length;
    session.lastSeason = R.seasonAt(state.tick);
    session.tutorialStep = -1;
    audio.setSeed(session.config.seed);
    render.setDecorationSeed(session.config.seed);
    app.away = { state, awayMin: Math.round((Date.now() - snap.savedAt) / 60000) };
    goTo("away", "btn-away-continue");
    render.sync(state, R.seasonAt(state.tick), true);
    return true;
  } catch {
    platform.setSnapshot(null);
    return false;
  }
}

// ------------------------------------------------------------------ input
// Keys and pad buttons (starhermit.txt control.* / engine.gamepad.*). With a widget focused (Tab), the arrows,
// Enter and Space are the UI's (engine.minor 20); a click or tap hands them back to the field.
const PLOT_COLS = 4;
onAction((e) => {
  if (!e.pressed) return;
  const s = screen();
  if (e.action === "back") {
    if (fresh(0)) return;
    if (s !== "play") { if (s !== "title") backScreen(); return; }
    // An open drawer covers its own toggle on phones, so Escape dismisses it first.
    if (app.drawer) { app.drawer = null; return; }
    pauseGame();
    return;
  }
  if (s !== "play" || !session.state || session.state.terminalReason) return;
  const st = session.state;
  const uiKeys = ui.focused() !== null && e.source !== "pointer";
  const n = st.plots.length;
  const at = app.selectedPlot < 0 ? 0 : app.selectedPlot;
  switch (e.action) {
    case "left": if (!uiKeys) selectPlot((at + n - 1) % n); break;
    case "right": if (!uiKeys) selectPlot((at + 1) % n); break;
    case "up": if (!uiKeys) selectPlot((at + n - PLOT_COLS) % n); break;
    case "down": if (!uiKeys) selectPlot((at + PLOT_COLS) % n); break;
    case "activate": if (!uiKeys && app.selectedPlot >= 0) activatePlot(app.selectedPlot); break;
    case "turnip": case "carrot": case "pumpkin": case "water": case "harvest":
      if (toolAllowed(e.action)) setTool(toolKey(app.tool) === e.action ? null : e.action);
      break;
    case "wait": if (!uiKeys) wait(); break;
    case "undo": session.undo(); break;
    case "pause": if (!fresh(0)) pauseGame(); break;
    case "hint": showHint(); break;
    case "camera": render.resetCamera(); break;
    default: break;
  }
});

// Pointer and touch on the 3D field (main.js setupInput): a press that moves over 24 px after 120 ms is a camera
// drag (bounded sideways orbit); otherwise its release selects the plot under it and uses the tool on it. The
// hovered plot gets the hover ring and the tool's legal-target ghost. Presses are queued and decided once the
// frame's UI is built, so a press on a widget is the widget's.
interface Press { kind: "down" | "move" | "up" | "cancel"; x: number; y: number }
const queued: Press[] = [];
let down: null | { x: number; y: number; at: number; drag: boolean } = null;
let lastTouch = -10;
let pointerUpFrame = -10;
/** A pointer button or finger lifted this frame or the last (a click or tap activates on its release). */
export function pointerActivation(): boolean { return frame().frame - pointerUpFrame <= 1; }
onPointerButton((e) => {
  if (!e.pressed) pointerUpFrame = frame().frame;
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queued.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) queued.push({ kind: "move", x, y }); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "end") pointerUpFrame = frame().frame;
  queued.push({ kind: e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel", x: e.x, y: e.y });
});
function fieldInput(): void {
  const playing = screen() === "play" && !!session.state && !session.state.terminalReason && !app.drawer;
  for (const q of queued.splice(0)) {
    const f = frame();
    if (q.kind === "cancel") { down = null; render.setGhost(-1, false); continue; }
    if (q.kind === "move") {
      if (down) {
        const d = Math.hypot(q.x - down.x, q.y - down.y) / f.scale;
        if (d > 24 && now() - down.at > 0.12) down.drag = true;
        if (down.drag) { render.orbit((q.x - down.x) / f.scale); down.x = q.x; down.y = q.y; continue; }
      }
      const i = playing && !ui.pointerOver() ? render.plotAt(q.x, q.y) : -1;
      render.setHovered(i);
      if (i >= 0 && app.tool && session.state) {
        const cmd: Command = { type: app.tool.type, plot: i };
        if (app.tool.type === "plant") cmd.crop = app.tool.crop;
        render.setGhost(i, R.check(session.state, cmd).ok);
      } else render.setGhost(-1, false);
      continue;
    }
    if (q.kind === "down") {
      down = null;
      if (!playing || ui.pointerOver()) continue;
      down = { x: q.x, y: q.y, at: now(), drag: false };
      audio.start();
      continue;
    }
    const d = down;
    down = null;
    render.setGhost(-1, false);
    if (!d || !playing || d.drag) continue;
    const i = render.plotAt(q.x, q.y);
    if (i >= 0) { selectPlot(i); activatePlot(i); ui.setFocus(null); }
  }
}

// ------------------------------------------------------------------ lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
audio.onCaption((text) => { if (options.captions) app.caption = { text, until: now() + 2 }; });

onStart(() => {
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.start();
  render.setReducedMotion(preferences().reducedMotion);
  render.setPalette(options.palette);
  applyLook();
  if (!tryResume()) goTo("title", "btn-play");
});
platform.onOptionsChange(() => render.setPalette(options.palette));
platform.onMerged(() => { /* screens read platform.progress each frame */ });
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast(account().signedOut));
// A hidden window saves a safe snapshot and holds the sound (main.js visibilitychange / pagehide).
onSuspend(() => { session.snapshotSave(); audio.setSuspended(true); platform.flush(); });
onResume(() => { audio.setSuspended(false); });
onQuit(() => { session.snapshotSave(); platform.flush(); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyPalette(ui.preferences().highContrast);
  audio.update();
  const t = now();
  if (app.banner && app.banner.until < t) app.banner = null;
  if (app.caption && app.caption.until < t) app.caption = null;
  if (app.toast && app.toast.until < t) app.toast = null;
});
onRender(() => {
  drawScreens();
  fieldInput();
  if (session.state) render.sync(session.state, R.seasonAt(session.state.tick));
  render.update(frameDt);
});

export { plain };
