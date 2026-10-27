// The browser build's DOM shell (index.html + style.css + js/main.js) as
// starhermit:ui, built every frame around the 3D field: the status bar (season,
// time, coins, score, mode, player and cloud-save chips, the drawer toggles and
// Pause), the left rail (objective with its progress bar, orders with Fulfill),
// the right rail (inventory, crafting, scores), the playfield with the hint
// banner, the caption line and the accessible plot mirror, the tool tray, the
// tutorial bubble, the toast, and the screens (title over the key art, modes,
// setup, results, pause, settings, help, leaderboards, friends, profile,
// welcome back). The browser's media queries are layouts picked by the
// window's logical size: desktop (≥ 1024 px: rails at the sides), compact (the
// rails become drawers), portrait phone (≤ 700 px wide: three tools a row,
// smaller mirror) and landscape phone (≤ 500 px tall: the status as a left
// column, the tools as a right column).
import { frame, openMenu } from "starhermit:engine";
import { requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Rules as R } from "./classic.ts";
import { account, N, plain, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  ACHIEVEMENTS, achievementName, activatePlot, app, backScreen, canUndo, copyInvite, copySeed, fresh, goTo, itemName, keysFor, leave,
  MODE_NAMES, objectiveText, openSetup, options, pauseGame, plotLabel, pointerActivation, restart, resultsHeadline, resume, scoreSoFar,
  SEASON_NAMES, selectPlot, session, setTool, showHint, showNext, showScreen, signIn, skipTutorial, startPending, toolAllowed, toolKey,
  tutorialText, wait, type Screen,
} from "./main.ts";

// ------------------------------------------------------------------ layout and helpers
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; desktop: boolean; portrait: boolean; landscape: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const landscape = lh <= 500 && lw > lh;
  const portrait = !landscape && lw <= 700 && lh >= lw;
  return { lw, lh, sc, ox: sa.left, oy: sa.top, desktop: lw >= 1024 && !landscape, portrait, landscape };
}
const lastSize = new Map<string, number>();
const prefs = (): ui.UiPreferences => ui.preferences();
function tw(text: string, style: string | (string | ui.Style)[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : style }).width / prefs().scale;
}
let firstId: string | null = null;
/** A button face's own text keeps the button's weight (content paragraphs take its colour only). */
const BOLD: ui.Style = { text: { weight: "600" } };
interface Btn { id: string; text: string; cls?: string; disabled?: boolean; selected?: boolean; act: () => void; sub?: string; sound?: boolean }
const btnW = (b: Btn): number => Math.max(tw(b.text, b.cls ?? "btn", "button"), b.sub ? tw(b.sub, "fine") + 34 : 0) + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `sub` adds a small second line. */
function button(b: Btn, width: number | null = null): boolean {
  const cls = b.cls ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const inner = width != null ? Math.max(20, width - 36) : null;
  const wraps = inner != null && tw(b.text, cls, "button") > width!;
  if (b.sub || wraps) {
    opts.content = () => {
      if (wraps) ui.style({ text: { align: "center", weight: "600" } }).paragraph(b.text, inner!);
      else ui.style(BOLD).label(b.text);
      if (b.sub) ui.style("fine", { text: { align: "center", weight: "600" } }).label(b.sub);
    };
  }
  if (!firstId && !b.disabled) firstId = b.id;
  const hit = ui.style(cls, width != null ? { width } : {}).id(b.id).button(b.text, opts);
  if (hit && !fresh(0)) b.act();
  return hit;
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap, centred). */
function flow(label: string, list: Btn[], width: number, gap = 10): void {
  const rows = wrapRows(list.map((b) => Math.min(width, btnW(b))), width, gap);
  let k = 0;
  ui.column(label, () => {
    rows.forEach((n, ri) => ui.row(`${label}-r${ri}`, () => {
      for (let i = 0; i < n; i++, k++) { const b = list[k]!; button(b, btnW(b) > width ? width : null); }
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align: "center", width });
}
/** How many items go on each row when items of `widths` wrap at `max`. */
function wrapRows(widths: number[], max: number, gap: number): number[] {
  const rows: number[] = [];
  let used = 0, n = 0;
  for (const w of widths) {
    if (n && used + gap + w > max) { rows.push(n); used = 0; n = 0; }
    used += (n ? gap : 0) + w;
    n++;
  }
  if (n) rows.push(n);
  return rows;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "p", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (tw(text, styles) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, center = true): void {
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  if (tw(text, styles, "heading") <= width) ui.style(...styles).heading(text);
  else ui.style(...styles).paragraph(text, width);
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  firstId = null;
  const s: Screen = app.stack[app.stack.length - 1] ?? (session.state && !session.state.terminalReason ? "play" : "title");
  const overScene = !!session.state && ["pause", "settings", "help", "leaderboard", "friends", "profile", "away"].includes(s);
  if (session.state && (s === "play" || overScene)) playScreen(L, overScene);
  else render.setPlayfield(0, 0, 0, 0);
  if (s !== "play") {
    // Screens: the page colour (the title key art), or a translucent scrim over the round for overlays.
    const cls = s === "title" ? (prefs().highContrast ? "page" : "title-page") : overScene ? "overlay-page" : "page";
    draw.box(0, 0, f.width, f.height, cls);
    const builders: Partial<Record<Screen, (w: number, L: Layout) => void>> = {
      title: titleScreen, modes: modesScreen, setup: setupScreen, results: resultsScreen, pause: pauseScreen, settings: settingsScreen,
      help: helpScreen, leaderboard: leaderboardScreen, friends: friendsScreen, profile: profileScreen, away: awayScreen,
    };
    const max: Partial<Record<Screen, number>> = { modes: 720, help: 640, settings: 480, pause: 420 };
    page(s, L, builders[s]!, max[s] ?? 560);
  }
  toast(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    const target = app.focusNext === "first" ? firstId : app.focusNext;
    if (age >= 1 && target && s !== "play") ui.setFocus(target);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen (index.html .screen.open): a centred column at most `max` wide, scrolling when taller than the window. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void, max: number): void {
  const padY = 16;
  const outer = Math.min(max, L.lw - 32);
  const avail = L.lh - 2 * padY;
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - (scroll ? 14 : 0);
  ui.place(`page-${key}`, "center", () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { width: inner, spacing: 14, align: "center" });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, fresh(3) ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}

// ------------------------------------------------------------------ title, modes, setup
function countdown(): string {
  const nowMs = platform.nowMs();
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  const ms = next.getTime() - nowMs;
  return T("Next seed in {h}h {m}m", { h: Math.floor(ms / 3600000), m: Math.floor((ms % 3600000) / 60000) });
}
function titleScreen(w: number): void {
  heading("h1", "Meadowstead", w);
  para(T("Restore a gentle homestead through the seasons."), w, "p", "tagline", true);
  button({ id: "btn-play", text: T("▶ Play"), cls: "big", act: () => showScreen("modes") });
  flow("title-row1", [
    { id: "btn-daily", text: T("📅 Daily Challenge"), sub: countdown(), act: () => openSetup("daily") },
    { id: "btn-journey", text: T("🗺 Journey"), sub: T("Stage {stage}/40", { stage: platform.progress.journeyStage }), act: () => openSetup("journey") },
    { id: "btn-profile", text: T("👤 Profile"), act: () => showScreen("profile", "btn-profile-done") },
  ], w);
  flow("title-row2", [
    { id: "btn-help-title", text: T("❓ Help"), act: () => showScreen("help", "btn-help-done") },
    { id: "btn-settings-title", text: T("⚙ Settings"), act: () => showScreen("settings", "btn-settings-done") },
  ], w);
  const acct: Btn[] = [];
  if (!platform.signedIn()) acct.push({ id: "btn-signin", text: account().signIn, act: signIn });
  if (platform.inviteLink()) acct.push({ id: "btn-invite", text: account().invite, act: copyInvite });
  if (acct.length) flow("title-row3", acct, w);
}
const MODES: [string, string, string, string][] = [
  ["learn", "🎓", N("Learn"), N("Interactive lessons, one rule at a time.")],
  ["journey", "🗺", N("Journey"), N("40 authored stages with mastery gates.")],
  ["daily", "📅", N("Daily"), N("One shared seed per UTC day.")],
  ["practice", "🌿", N("Practice"), N("Selectable difficulty, undo, unranked.")],
  ["challenge", "🏆", N("Challenge"), N("Move limits and restricted tools.")],
  ["score", "📈", N("Score Chase"), N("Chase a high score on a fixed seed.")],
];
function modesScreen(w: number): void {
  heading("h1", T("Choose a mode"), w);
  const gap = 10;
  const cols = Math.max(1, Math.floor((w + gap) / (180 + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.grid("mode-grid", () => {
    for (const [mode, icon, name, desc] of MODES) {
      if (!firstId) firstId = `mode-${mode}`;
      const hit = ui.style("mode", { width: cw }).id(`mode-${mode}`).button(T(name), {
        content: () => ui.column(`mode-${mode}-face`, () => {
          ui.style("mode-icon").label(icon);
          ui.style("mode-name").label(T(name));
          para(T(desc), cw - 36, "mode-desc", undefined, true);
        }, { align: "center", width: cw - 36, spacing: 4 }),
      });
      if (hit && !fresh(0)) openSetup(mode);
    }
  }, { columns: cols, gap, width: w });
  button({ id: "btn-modes-back", text: T("← Back"), act: backScreen });
}
function setupScreen(w: number): void {
  const pend = app.pending;
  if (!pend) return;
  const cfg = pend.config;
  heading("h1", T("Session setup"), w);
  const p = (text: string, cls = "p"): void => para(plain(text), w, cls, undefined, true);
  if (cfg.mode === "learn") p(T("Interactive lessons. Unranked. About 3 minutes."));
  else if (cfg.mode === "journey") {
    const vars = { stage: pend.stage, goal: cfg.goalOrders, ticks: cfg.maxTicks };
    p(cfg.mastery ? T("Stage {stage}/40 — <b>Mastery stage</b> (smaller field!). Ranked: no. Goal: {goal} orders in {ticks} ticks.", vars)
      : T("Stage {stage}/40. Ranked: no. Goal: {goal} orders in {ticks} ticks.", vars));
  } else if (cfg.mode === "daily") {
    p(T("Daily challenge for <b>{date}</b>. One shared seed for everyone.", { date: pend.date }) + " " +
      (platform.signedIn() ? T("Your result is kept as a personal best, synced to your cloud save.") : T("<b>Ranked.</b>")));
    const done = platform.progress.completedDailies[pend.date];
    if (done) p(T("Completed today: {points} points. You can replay to improve.", { points: done }), "fine");
  } else if (cfg.mode === "practice") {
    p(T("Relaxed play with undo. Unranked, no effect on ratings."));
    choice("opt-difficulty", T("Difficulty"), [["easy", N("Easy")], ["normal", N("Normal")], ["hard", N("Hard")]], pend.difficulty, (v) => { pend.difficulty = v; }, w);
  } else if (cfg.mode === "challenge") {
    p(T("<b>Blitz:</b> fulfill 5 orders in only 40 ticks. Ranked: no."));
    choice("opt-variant", T("Variant"), [["blitz", N("Blitz (time limit)")], ["small", N("Small field (8 plots)")], ["nocraft", N("No crafting")]], pend.variant, (v) => { pend.variant = v; }, w);
  } else if (cfg.mode === "score") {
    p(platform.signedIn() ? T("Fixed seed score chase. <b>Ranked</b> on the StarHermit leaderboard.") : T("Fixed seed score chase. <b>Ranked</b> on the global board."));
  }
  flow("setup-actions", [
    { id: "btn-start-session", text: T("Start"), cls: "primary", act: startPending },
    { id: "btn-setup-back", text: T("← Back"), act: backScreen },
  ], w);
}
/** A labelled select (index.html <label>…<select>). */
function choice(id: string, label: string, opts: [string, string][], value: string, set: (v: string) => void, w: number): void {
  const idx = Math.max(0, opts.findIndex(([v]) => v === value));
  const sw = Math.min(240, w * 0.6);
  ui.row(`${id}-row`, () => {
    para(label, w - sw - 12, "set-label");
    ui.spacer();
    const pick = ui.id(id).select(label, idx, opts.map(([, l]) => T(l)), { width: sw } as ui.WidgetOptions);
    if (pick !== idx) set(opts[pick]![0]);
  }, { width: Math.min(w, 420), align: "center" });
}

// ------------------------------------------------------------------ results, pause, away
function resultsScreen(w: number, L: Layout): void {
  const st = session.state;
  if (!st || !st.score) return;
  const s = st.score;
  heading("h1", T("Results"), w);
  if (L.lh > 640) {
    const aw = Math.min(420, w, L.lw * 0.8), ah = aw * 576 / 1024;
    ui.style("results-art", { width: aw, height: ah, background: [{ image: "assets/results-harvest.webp", size: "cover" }, "#cfe0bf"] })
      .column("results-art", () => undefined, { width: aw, height: ah });
  }
  para(resultsHeadline(), w, "headline", "results-headline", true);
  const tw2 = Math.min(w, 360);
  const labels: [string, string][] = [["orders", N("Orders")], ["harvests", N("Harvests")], ["crafting", N("Crafting")], ["coins", N("Coins")], ["variety", N("Crop variety")], ["timeBonus", N("Time bonus")]];
  ui.id("score-breakdown").column(T("Score breakdown"), () => {
    for (const [k, label] of labels) scoreRow(`score-${k}`, T(label), String(s[k as keyof typeof s]), tw2, "score-v");
    scoreRow("score-total", T("Total"), String(s.total), tw2, "score-k");
  }, { width: tw2 });
  const note = app.note?.();
  if (note) para(note, w, "fine", "results-lb", true);
  if (app.lastAchievement) para("🏅 " + achievementName(app.lastAchievement), w, "p", "achievements-earned", true);
  const list: Btn[] = [{ id: "btn-retry", text: T("↻ Retry"), cls: "primary", act: restart }];
  if (showNext()) list.push({ id: "btn-next", text: T("Next →"), act: () => openSetup("journey") });
  list.push({ id: "btn-results-home", text: T("Home"), act: () => goTo("title", "btn-play") });
  flow("results-actions", list, w);
}
function scoreRow(id: string, k: string, v: string, w: number, vcls: string): void {
  ui.row(id, () => {
    para(k, w - 100, "score-k");
    ui.spacer();
    ui.style(vcls).id(`${id}-v`).label(v);
  }, { width: w, style: "score-row" });
}
function pauseScreen(w: number): void {
  heading("h1", T("Paused"), w);
  button({ id: "btn-resume", text: T("▶ Resume"), cls: "big", act: resume });
  flow("pause-row", [
    { id: "btn-settings-pause", text: T("⚙ Settings"), act: () => showScreen("settings", "btn-settings-done") },
    { id: "btn-help-pause", text: T("❓ Help"), act: () => showScreen("help", "btn-help-done") },
    { id: "btn-restart-pause", text: T("↻ Restart"), act: restart },
    { id: "btn-leave", text: T("🚪 Leave"), cls: "danger", act: leave },
  ], Math.min(w, 420));
}
function awayScreen(w: number): void {
  const a = app.away;
  heading("h1", T("Welcome back"), w);
  if (a) {
    const st = a.state;
    const vars = { mode: T(MODE_NAMES[st.mode] ?? st.mode), tick: st.tick, max: st.maxTicks, done: st.ordersFulfilled, goal: st.goalOrders, min: a.awayMin };
    para(a.awayMin > 0
      ? T("Your {mode} session was saved at time {tick}/{max} ({done}/{goal} orders, {min} min ago). The solo simulation paused while you were away.", vars)
      : T("Your {mode} session was saved at time {tick}/{max} ({done}/{goal} orders). The solo simulation paused while you were away.", vars), w, "p", "away-summary", true);
  }
  button({ id: "btn-away-continue", text: T("Continue"), cls: "primary", act: resume });
}

// ------------------------------------------------------------------ settings, help
const PALETTES: [string, string][] = [["default", N("Default")], ["deuteranopia", N("Deuteranopia")], ["protanopia", N("Protanopia")], ["tritanopia", N("Tritanopia")], ["high-contrast", N("High contrast")]];
const CHECKS: [keyof platform.Options, string][] = [["leftHanded", N("Left-handed controls")], ["haptics", N("Haptics")], ["captions", N("Captions")]];
function settingsScreen(w: number): void {
  heading("h1", T("Settings"), w);
  para(T("Sound, graphics, language, reduced motion, high contrast and larger text are in the StarHermit Options."), w, "fine", "options-note", true);
  flow("options-row", [
    { id: "btn-options", text: T("Audio & graphics"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Keyboard bindings"), act: () => requestRebind() },
  ], w);
  choice("set-palette", T("Color palette"), PALETTES, options.palette, (v) => platform.setOption("palette", v), w);
  ui.column("set-checks", () => {
    for (const [key, label] of CHECKS) {
      const cur = !!options[key];
      const next = ui.id(`set-${key}`).checkbox(T(label), cur);
      if (next !== cur) platform.setOption(key, next as never);
    }
  }, { spacing: 2, width: Math.min(w, 420) });
  ui.row("tutorial-row", () => {
    para(T("Replay tutorial"), w - 120, "set-label");
    ui.spacer();
    button({ id: "btn-replay-tutorial", text: T("Start"), act: () => openSetup("learn") });
  }, { width: Math.min(w, 420), align: "center" });
  button({ id: "btn-settings-done", text: T("← Done"), act: backScreen });
}
function helpScreen(w: number): void {
  heading("h1", T("How to play"), w);
  const cards: [string, string][] = [
    [T("Goal"), T("Fulfill orders before time runs out. Every action (plant, water, harvest, craft, wait) advances time by one tick.")],
    [T("Planting"), T("Pick a seed tool (keys 1–3) then a plot. Each crop grows only in its seasons — the banner shows the current season.")],
    [T("Watering"), T("Crops grow one stage per tick only while watered. Water (W) after every action. A crop left thirsty for 4 ticks withers.")],
    [T("Harvest & Craft"), T("Harvest (H) ready crops into your inventory. Combine crops into goods like Garden Salad and Harvest Pie for higher order rewards.")],
    [T("Orders"), T("Orders are listed on the left. When you have the items, the order is highlighted — press Fulfill to earn coins and score.")],
    [T("Controls"), T("{move} move between plots, {act} acts, {wait} waits, {undo} undo (practice), {pause} pause, {hint} hint, {camera} reset camera, {back} back. Touch: tap a tool then a plot; drag to orbit the camera.", {
      move: ["left", "right", "up", "down"].map(keysFor).join(" "), act: keysFor("activate"), wait: keysFor("wait"), undo: keysFor("undo"),
      pause: keysFor("pause"), hint: keysFor("hint"), camera: keysFor("camera"), back: keysFor("back"),
    })],
    [T("Scoring"), T("Score = orders + harvests×5 + crafting×15 + coins + variety×25 + time bonus. Ties break on goal completion, fewer invalid actions, then faster time.")],
  ];
  cards.forEach(([t, body], i) => ui.column(`help-card-${i}`, () => {
    para(t, w - 32, "h3");
    para(body, w - 32, "p");
  }, { style: "card", width: w, spacing: 4 }));
  button({ id: "btn-help-done", text: T("← Done"), act: backScreen });
}

// ------------------------------------------------------------------ leaderboards, friends, profile
interface Row { name: string; score: number }
const lb = { board: "" as string, rows: null as Row[] | null, note: (): string => "", token: 0 };
function localRows(board: string): Row[] {
  const p = platform.progress;
  return p.localBoard.filter((r) => board === "friends" ? p.friends.includes(r.name) : r.board === (board === "daily" ? "daily" : "global"));
}
function loadBoard(board: "global" | "daily" | "friends"): void {
  app.board = board;
  lb.board = board;
  lb.rows = null;
  lb.note = () => "";
  const token = ++lb.token;
  if (!platform.signedIn()) { lb.rows = localRows(board); lb.note = () => T("Local board (this device)."); return; }
  if (board === "daily") {
    // The platform leaderboard is a single board; per-day rows live on the local board.
    lb.rows = localRows("daily");
    lb.note = () => T("Today's seed — your scores (local). The platform board is global.");
    return;
  }
  platform.boardEntries(board === "friends").then((rows) => {
    if (token !== lb.token) return;
    const base = board === "friends" ? N("Platform leaderboard — friends only (read-only). Ranked rows are validated platform-side.")
      : N("Platform leaderboard (read-only). Ranked rows are validated platform-side.");
    if (rows.length) { lb.rows = rows; lb.note = () => T(base); }
    else { lb.rows = localRows(board); lb.note = () => T(base) + " " + T("No platform entries — showing local records."); }
  }, (e: unknown) => {
    if (token !== lb.token) return;
    lb.rows = localRows(board);
    const msg = e instanceof Error ? e.message : String(e);
    lb.note = () => T("Platform leaderboard unavailable ({error}) — showing local board.", { error: msg });
  });
}
export function openLeaderboard(): void { loadBoard("global"); showScreen("leaderboard"); }
function leaderboardScreen(w: number): void {
  if (lb.board !== app.board) loadBoard(app.board);
  heading("h1", T("Leaderboards"), w);
  ui.row("lb-tabs", () => {
    for (const [b, label] of [["global", N("Global")], ["daily", N("Daily")], ["friends", N("Friends")]] as const) {
      button({ id: `lb-tab-${b}`, text: T(label), selected: app.board === b, act: () => loadBoard(b) });
    }
  }, { spacing: 10, role: "radiogroup" } as ui.Layout);
  const lw = Math.min(w, 420);
  ui.column("lb-list", () => {
    if (!lb.rows) { para(T("Loading…"), lw, "row-text", "lb-loading"); return; }
    if (!lb.rows.length) { listRow("lb-empty", T("No scores yet — be the first!"), "", lw); return; }
    lb.rows.slice(0, 20).forEach((r, i) => listRow(`lb-${i}`, `${i + 1}. ${r.name || T("Player")}`, String(r.score), lw, true));
  }, { width: lw, spacing: 4 });
  para(lb.note(), w, "fine", "lb-note", true);
  button({ id: "btn-lb-done", text: T("← Done"), act: backScreen });
}
function listRow(id: string, left: string, right: string, w: number, bold = false): void {
  ui.row(id, () => {
    para(left, w - (right ? 110 : 24), "row-text");
    if (right) { ui.spacer(); ui.style(bold ? "score-k" : "row-text").label(right); }
  }, { width: w, style: "lb-row" });
}
const fr = { rows: null as { name: string; score: string }[] | null, token: 0, name: "" };
export function openFriends(): void {
  fr.rows = null;
  const token = ++fr.token;
  if (platform.signedIn()) {
    Promise.all([platform.friendList().catch(() => []), platform.boardEntries(true).catch(() => [])]).then(([friends, entries]) => {
      if (token !== fr.token) return;
      const best = new Map(entries.map((e) => [e.userId, e.score]));
      fr.rows = friends.map((f) => ({ name: (f.online ? "🟢 " : "") + f.name, score: best.has(f.userId) ? String(best.get(f.userId)) : "" }));
    });
  }
  showScreen("friends");
}
function friendsScreen(w: number): void {
  heading("h1", T("Friends"), w);
  para(T("Compare scores with friends on shared seeds. Invite by sharing today's daily seed."), w, "fine", "friends-note", true);
  const lw = Math.min(w, 420);
  const pts = (s: string): string => (s ? T("{n} pts", { n: s }) : T("no scores"));
  if (platform.signedIn()) {
    // Friends come from the platform account; the free-text add row is local only.
    ui.column("friends-list", () => {
      if (!fr.rows) { para(T("Loading…"), lw, "row-text"); return; }
      if (!fr.rows.length) para(T("No friends on the platform yet. Use Invite a friend to send a link."), lw, "fine", "friends-none");
      fr.rows.forEach((r, i) => listRow(`friend-${i}`, r.name, pts(r.score), lw));
    }, { width: lw, spacing: 4 });
  } else {
    const p = platform.progress;
    ui.row("friend-add", () => {
      fr.name = ui.id("friend-name").textField("friend-name", fr.name, { maxChars: 24, width: lw - 100, placeholder: T("Friend display name") });
      const add = (): void => {
        const name = fr.name.trim();
        if (!name) return;
        if (!p.friends.includes(name)) p.friends.push(name);
        fr.name = "";
        platform.saveProgress();
      };
      button({ id: "btn-add-friend", text: T("Add"), act: add });
      if (ui.submitted("friend-name")) add();
    }, { width: lw, spacing: 10, align: "center" });
    ui.column("friends-list", () => {
      if (!p.friends.length) para(T("No friends added yet."), lw, "fine", "friends-none");
      p.friends.forEach((f, i) => {
        const best = p.localBoard.filter((r) => r.name === f).map((r) => r.score).sort((a, b) => b - a)[0];
        listRow(`friend-${i}`, f, pts(best != null ? String(best) : ""), lw);
      });
    }, { width: lw, spacing: 4 });
  }
  button({ id: "btn-share-seed", text: T("🔗 Copy today's challenge seed"), act: copySeed });
  button({ id: "btn-friends-done", text: T("← Done"), act: backScreen });
}
const SYNC: Record<string, string> = { synced: N("☁ synced"), saving: N("☁ saving…"), offline: N("☁ offline") };
const syncText = (): string => T(SYNC[platform.syncState()] ?? N("☁ offline"));
function profileScreen(w: number): void {
  const p = platform.progress;
  heading("h1", T("Profile"), w);
  para(plain(platform.signedIn()
    ? T("Playing as <b>{name}</b> · cloud save: {sync}", { name: platform.displayName(T("You")), sync: syncText() })
    : T("Local profile — progress is saved on this device.")), w, "fine", "profile-who", true);
  para(T("Journey stage {stage}/40 · Mastery {xp} XP · Lifetime coins 🪙{coins} · Daily streak {streak}",
    { stage: p.journeyStage, xp: p.masteryXp, coins: p.lifetimeCoins, streak: p.dailyStreak }), w, "p", "profile-summary", true);
  heading("h2", T("Achievements"), w);
  ui.column("achievements-list", () => {
    for (const a of ACHIEVEMENTS) {
      const got = !!p.achievements[a.key];
      para((got ? "🏅 " : "🔒 ") + T(a.name) + " — " + T(a.desc), Math.min(w, 480), got ? "ach-on" : "ach-off", `ach-${a.key}`);
    }
  }, { width: Math.min(w, 480), spacing: 6 });
  heading("h2", T("Mastery track"), w);
  ui.id("mastery-track").progress(Math.max(0, Math.min(1, (p.journeyStage - 1) / 40)), Math.min(w, 300));
  button({ id: "btn-profile-done", text: T("← Done"), act: backScreen });
}

// ------------------------------------------------------------------ play
const ROW = 44;
const TOOLS: [string, string][] = [["turnip", N("🌱 Turnip")], ["carrot", N("🥕 Carrot")], ["pumpkin", N("🎃 Pumpkin")], ["water", N("💧 Water")], ["harvest", N("🧺 Harvest")]];
interface Chip { id: string; text: string; btn?: () => void; aria?: string }
function chips(): Chip[] {
  const st = session.state!;
  const list: Chip[] = [];
  const compact = !layoutNow().desktop;
  if (compact) list.push({ id: "btn-drawer-left", text: "📋", aria: T("Open objective and orders panel"), btn: () => { app.drawer = app.drawer === "left" ? null : "left"; } });
  list.push(
    { id: "sb-season", text: T(SEASON_NAMES[R.seasonAt(st.tick)]!) },
    { id: "sb-tick", text: T("Time {tick}/{max}", { tick: st.tick, max: st.maxTicks }) },
    { id: "sb-coins", text: "🪙 " + st.coins },
    { id: "sb-score", text: T("Score {n}", { n: scoreSoFar(st) }) },
    { id: "sb-mode", text: T(MODE_NAMES[st.mode] ?? st.mode) },
  );
  if (platform.signedIn()) {
    list.push({ id: "sb-player", text: "👤 " + platform.displayName(T("You")) });
    list.push({ id: "sb-sync", text: syncText() });
  }
  if (compact) list.push({ id: "btn-drawer-right", text: "🎒", aria: T("Open inventory and actions panel"), btn: () => { app.drawer = app.drawer === "right" ? null : "right"; } });
  list.push({ id: "btn-pause", text: T("⏸ Pause"), aria: T("Pause (P)"), btn: pauseGame });
  return list;
}
const chipW = (c: Chip): number => c.btn ? tw(c.text, "btn", "button") + 4 : tw(c.text, "chip-text") + 26;
function chip(c: Chip, width: number | null = null): void {
  if (c.btn) {
    const hit = ui.style("btn", width != null ? { width } : {}).id(c.id).button(c.aria ?? c.text, c.aria ? { content: () => ui.style(BOLD).label(c.text) } : {});
    if (hit && !fresh(0)) { c.btn(); if (pointerActivation()) ui.setFocus(null); }
    return;
  }
  ui.row(c.id, () => para(c.text, (width ?? 400) - 26, "chip-text"), { style: "chip", ...(width != null ? { width } : {}), align: "center" });
}
interface ToolBtn { id: string; text: string; kbd: string; tool?: string; disabled?: boolean; act: () => void }
function trayButtons(): ToolBtn[] {
  const list: ToolBtn[] = TOOLS.map(([key, label]) => ({
    id: `tool-${key}`, text: T(label), kbd: keysFor(key), tool: key, disabled: !toolAllowed(key),
    act: () => setTool(toolKey(app.tool) === key ? null : key),
  }));
  list.push(
    { id: "tool-wait", text: T("⏳ Wait"), kbd: keysFor("wait"), act: wait },
    { id: "btn-undo", text: T("↩ Undo"), kbd: keysFor("undo"), disabled: !canUndo(), act: () => session.undo() },
    { id: "btn-hint", text: T("💡 Hint"), kbd: keysFor("hint"), act: showHint },
  );
  if (options.leftHanded) list.reverse();
  return list;
}
function toolWidth(b: ToolBtn, kbd: boolean): number { return tw(b.text, "tool", "button") + (kbd ? tw(b.kbd, "kbd") + 6 : 0) + 4; }
function toolButton(b: ToolBtn, width: number | null, kbd: boolean): void {
  const sel = !!b.tool && toolKey(app.tool) === b.tool;
  const opts: ui.ButtonOptions = { content: () => ui.row(`${b.id}-face`, () => {
    ui.style(BOLD).label(b.text);
    if (kbd) ui.style(sel ? "kbd-on" : "kbd").label(b.kbd);
  }, { spacing: 6, align: "center" }) };
  if (b.disabled) opts.disabled = true;
  if (b.tool) opts.selected = sel;
  const hit = ui.style("tool", width != null ? { width } : {}).id(b.id).button(b.text, opts);
  if (hit && !fresh(0)) { b.act(); if (pointerActivation()) ui.setFocus(null); }
}

/** The round's screen; `inert` (an overlay screen over it): only the field and the page around it. */
function playScreen(L: Layout, inert: boolean): void {
  const pad = L.portrait ? 4 : 8, gap = L.portrait ? 4 : 8;
  const cl = chips();
  const tools = trayButtons();
  let pf: { x: number; y: number; w: number; h: number };
  if (L.landscape) {
    // Status column left, play centre, tools in their own right column (each keeps a full 44 px target).
    const colW = Math.min(150, Math.max(120, L.lw * 0.17));
    pf = { x: pad + colW + gap, y: pad, w: L.lw - 2 * pad - 2 * colW - 2 * gap, h: L.lh - 2 * pad };
    if (!inert) sideColumn("status-col", "top-start", pad, pad, colW, pf.h, () => cl.forEach((c) => chip(c, colW - 14)), L);
    if (!inert) sideColumn("tool-col", "top-end", pad, pad, colW, pf.h, () => tools.forEach((b) => toolButton(b, colW - 14, false)), L);
  } else {
    const inner = L.lw - 2 * pad;
    const statusRows = wrapRows(cl.map(chipW), inner, 8);
    const statusH = statusRows.length * ROW + (statusRows.length - 1) * 8;
    const kbd = !L.portrait;
    let trayRowsN: number[];
    if (L.portrait) trayRowsN = [3, 3, 2];
    else trayRowsN = wrapRows(tools.map((b) => toolWidth(b, kbd)), inner, 8);
    const trayH = trayRowsN.length * ROW + (trayRowsN.length - 1) * 8;
    const railW = L.desktop ? 260 : 0;
    pf = { x: pad + (railW ? railW + gap : 0), y: pad + statusH + gap, w: inner - (railW ? 2 * (railW + gap) : 0), h: L.lh - 2 * pad - statusH - trayH - 2 * gap };
    // The status bar (a flex-wrap row).
    let k = 0;
    if (!inert) ui.place("statusbar", { anchor: "top-start", x: pad, y: pad }, () => ui.column("status-rows", () => {
      statusRows.forEach((n, ri) => ui.row(`status-r${ri}`, () => { for (let i = 0; i < n; i++, k++) chip(cl[k]!); }, { spacing: 8, align: "center", height: ROW }));
    }, { spacing: 8 }));
    // The tool tray (centred flex-wrap rows; three a row on portrait phones).
    let t = 0;
    if (!inert) ui.place("tooltray", { anchor: "bottom", y: pad }, () => ui.id("tray-rows").column(T("Tools"), () => {
      trayRowsN.forEach((n, ri) => ui.row(`tray-r${ri}`, () => { for (let i = 0; i < n && t < tools.length; i++, t++) toolButton(tools[t]!, L.portrait ? (inner - (n - 1) * 8) / n : null, kbd); }, { spacing: 8, align: "center" }));
    }, { spacing: 8, align: "center" }));
    if (L.desktop && !inert) {
      rail("left", pad, pf.y, railW, pf.h, L, "top-start");
      rail("right", pad, pf.y, railW, pf.h, L, "top-end");
    }
  }
  // The 3D field draws into the playfield; the page colour around it, with the playfield's rounded corners.
  const sc = L.sc, wx = L.ox + pf.x * sc, wy = L.oy + pf.y * sc, ww = Math.max(1, pf.w * sc), wh = Math.max(1, pf.h * sc);
  render.setPlayfield(wx, wy, ww, wh);
  const f = frame();
  draw.box(0, 0, f.width, wy, "page");
  draw.box(0, wy + wh, f.width, f.height - wy - wh, "page");
  draw.box(0, wy, wx, wh, "page");
  draw.box(wx + ww, wy, f.width - wx - ww, wh, "page");
  const ring = 16;
  draw.box(wx - ring * sc, wy - ring * sc, ww + 2 * ring * sc, wh + 2 * ring * sc, { border: { width: ring, color: "$bg" }, radius: 12 + ring });
  if (inert) return;
  playfieldOverlays(pf, L);
  if (!L.desktop && app.drawer) drawer(L);
  tutorialBubble(L);
  ui.target(T("Meadowstead playfield"), { x: pf.x, y: pf.y, width: pf.w, height: pf.h }, { role: "label" });
}
function sideColumn(key: string, anchor: "top-start" | "top-end", x: number, y: number, w: number, h: number, build: () => void, L: Layout): void {
  const natural = lastSize.get(key) ?? 0;
  ui.place(key, { anchor, x, y }, () => {
    const body = (): void => { const r = ui.column(`${key}-col`, build, { spacing: 6, width: w - 14 }); lastSize.set(key, r.height / L.sc); };
    if (natural > h) ui.scrollArea(`${key}-scroll`, { width: w, height: h }, body);
    else body();
  });
}

/** A rail (index.html aside): left — objective and orders; right — inventory, crafting and scores. */
function rail(side: "left" | "right", x: number, y: number, w: number, h: number, L: Layout, anchor: "top-start" | "top-end"): void {
  const key = `rail-${side}`;
  const natural = lastSize.get(key) ?? 0;
  const scroll = natural > h;
  const inner = w - (scroll ? 14 : 0);
  ui.place(key, { anchor, x, y }, () => {
    const body = (): void => {
      const r = ui.id(`${key}-col`).column(side === "left" ? T("Objective and orders") : T("Inventory and actions"), () => (side === "left" ? leftRail(inner) : rightRail(inner)), { width: inner, spacing: 8 });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: w, height: h }, body);
    else body();
  });
}
function panel(id: string, w: number, build: (inner: number) => void): void {
  ui.column(id, () => build(w - 24), { style: "panel", width: w, spacing: 6 });
}
function leftRail(w: number): void {
  const st = session.state!;
  panel("panel-objective", w, (iw) => {
    para(T("Objective"), iw, "h2");
    para(objectiveText(), iw, "p", "objective-text");
    ui.id("objective-progress").progress(st.ordersFulfilled / st.goalOrders, Math.min(160, iw));
  });
  panel("panel-orders", w, (iw) => {
    para(T("Orders"), iw, "h2");
    for (const o of st.orders) {
      const needs = Object.entries(o.needs).map(([k, n]) => `${n}× ${itemName(k)}`).join(", ");
      const can = R.check(st, { type: "fulfill", orderId: o.id }).ok;
      const fw = tw(T("Fulfill"), "small-btn", "button") + 4;
      ui.row(`order-${o.id}`, () => {
        para(`${needs} → 🪙${o.reward}`, iw - fw - 22, "row-text");
        ui.spacer();
        const hit = ui.style("small-btn").id(`fulfill-${o.id}`).button(T("Fulfill order for {needs}, reward {reward} coins", { needs, reward: o.reward }), {
          disabled: !can, content: () => ui.style(BOLD).label(T("Fulfill")),
        });
        if (hit && !fresh(0)) { session.command({ type: "fulfill", orderId: o.id }); if (pointerActivation()) ui.setFocus(null); }
      }, { width: iw, style: can ? "order-ok" : "order", align: "center", spacing: 6 });
    }
  });
}
function rightRail(w: number): void {
  const st = session.state!;
  panel("panel-inventory", w, (iw) => {
    para(T("Inventory"), iw, "h2");
    const entries = Object.entries(st.inventory).filter(([, n]) => n > 0);
    if (!entries.length) ui.row("inv-empty", () => para(T("Empty — plant something!"), iw - 16, "row-text"), { width: iw, style: "inv" });
    for (const [k, n] of entries) ui.row(`inv-${k}`, () => para(`${itemName(k)} × ${n}`, iw - 16, "row-text"), { width: iw, style: "inv" });
  });
  panel("panel-craft", w, (iw) => {
    para(T("Craft"), iw, "h2");
    for (const key of st.allowedRecipes) {
      const r = R.RECIPES[key]!;
      const can = R.check(st, { type: "craft", recipe: key }).ok;
      const needs = Object.entries(r.needs).map(([k, n]) => `${n} ${itemName(k)}`).join(" + ");
      const text = `${itemName(key)} (${needs})`;
      const hit = ui.style("btn", { width: iw }).id(`craft-${key}`).button(T("Craft {name} from {needs}", { name: itemName(key), needs }), {
        disabled: !can, content: () => ui.style({ text: { align: "center", weight: "600" } }).paragraph(text, iw - 36),
      });
      if (hit && !fresh(0)) { session.command({ type: "craft", recipe: key }); if (pointerActivation()) ui.setFocus(null); }
    }
    if (!st.allowedRecipes.length) para(T("No recipes unlocked in this session."), iw, "fine");
  });
  panel("panel-scores", w, (iw) => {
    para(T("Scores"), iw, "h2");
    button({ id: "btn-leaderboard", text: T("Leaderboards"), act: openLeaderboard }, iw);
    button({ id: "btn-friends", text: T("Friends"), act: openFriends }, iw);
  });
}
/** Compact layouts: a rail slides in as a full-height drawer; a tap outside closes it. */
function drawer(L: Layout): void {
  const w = Math.min(L.lw * 0.8, 300);
  const side = app.drawer!;
  // The rest of the window closes it (index.html: a tap outside an open drawer).
  ui.place("drawer-scrim", { anchor: side === "left" ? "top-end" : "top-start", x: 0, y: 0 }, () => {
    const r = ui.widget(T("Close panel"), { role: "button", size: { width: Math.max(1, L.lw - w), height: L.lh } });
    if (r.activated && !fresh(0)) app.drawer = null;
  });
  const key = `drawer-${side}`;
  const natural = lastSize.get(key) ?? 0;
  const inner = w - 24 - (natural > L.lh - 24 ? 14 : 0);
  ui.place(key, { anchor: side === "left" ? "top-start" : "top-end", x: 0, y: 0 }, () => ui.column(`${key}-box`, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => (side === "left" ? leftRail(inner) : rightRail(inner)), { width: inner, spacing: 8 });
      lastSize.set(key, r.height / L.sc);
    };
    if (natural > L.lh - 24) ui.scrollArea(`${key}-scroll`, { width: w - 24, height: L.lh - 24 }, body);
    else body();
  }, { style: "drawer", width: w, height: L.lh }));
}

/** Over the field: the hint banner (top), the plot mirror (bottom-left), the caption (bottom-right). */
function playfieldOverlays(pf: { x: number; y: number; w: number; h: number }, L: Layout): void {
  const b = app.banner;
  if (b) {
    const maxW = Math.min(pf.w - 16, 560);
    const w = Math.min(maxW, tw(b.text, "hint-text") + 32);
    ui.place("hint-banner", { anchor: "top-start", x: pf.x + (pf.w - w) / 2, y: pf.y + 8 }, () =>
      ui.column("hint-col", () => para(b.text, w - 32, "hint-text", "hint-text", true), { style: "hint-banner", width: w, align: "center" }));
  }
  // The accessible plot mirror (index.html #board-mirror): one button per plot, its state as an icon.
  const st = session.state!;
  const n = st.plots.length;
  const g = L.portrait ? 3 : 4;
  const maxW = Math.min(L.portrait ? 216 : 320, pf.w - 16);
  const cw = Math.max(36, (maxW - 3 * g) / 4);
  const rows = Math.ceil(n / 4);
  const cellH = L.portrait ? 40 : 44;
  ui.place("board-mirror", { anchor: "top-start", x: pf.x + 8, y: pf.y + pf.h - 8 - rows * cellH - (rows - 1) * g }, () => ui.id("mirror-grid").grid(T("Farm plots"), () => {
    for (let i = 0; i < n; i++) {
      const c = st.plots[i]!.crop;
      const icon = !c ? "▫" : c.ready ? "🌟" : c.watered ? "💧" : "🌱";
      const sel = i === app.selectedPlot;
      const label = plotLabel(i);
      const hit = ui.style(sel ? "plot-sel" : "plot", { width: cw, height: cellH }).id(`plot-${i + 1}`).button(sel ? T("{label}, selected", { label }) : label, {
        content: () => { ui.style("plot-icon", { text: { align: "center" } }).label(icon); ui.style("plot-num", { text: { align: "center" } }).label(String(i + 1)); },
      });
      if (hit && !fresh(0)) { selectPlot(i); activatePlot(i); if (pointerActivation()) ui.setFocus(null); }
    }
  }, { columns: 4, gap: g, width: cw * 4 + 3 * g }));
  const cap = app.caption;
  if (cap) {
    const text = "♪ " + T(cap.text);
    const w = tw(text, "caption-text") + 20;
    ui.place("caption-line", { anchor: "top-start", x: pf.x + pf.w - 8 - w, y: pf.y + pf.h - 8 - 24 }, () =>
      ui.row("caption-row", () => ui.style("caption-text").label(text), { style: "caption" }));
  }
}
function tutorialBubble(L: Layout): void {
  const text = tutorialText();
  if (!text || app.stack.length) return;
  const w = Math.min(L.lw * 0.9, 480);
  ui.place("tutorial-bubble", { anchor: "bottom", y: L.landscape ? 12 : 90 }, () => ui.id("tutorial-col").column(T("Tutorial"), () => {
    para(text, w - 42, "p", "tutorial-text");
    button({ id: "btn-tutorial-skip", text: T("Skip tutorial"), act: skipTutorial });
  }, { style: "bubble", width: w, spacing: 10, align: "center" }));
}
function toast(L: Layout): void {
  const t = app.toast;
  if (!t) return;
  const w = Math.min(L.lw * 0.92, 420);
  ui.place("toast", { anchor: "bottom", y: 16 }, () => ui.column("toast-col", () => para(t.text, w - 36, "p", "toast-text", true), { style: "toast", width: w, align: "center" }));
}
