# Meadowstead — game design document (running spec)

This document describes the game as it ships today. Present tense throughout; anything the design
wants but the code does not yet do is listed once, at the end, under "Design intent not yet implemented".

---

## 1. Overview

**Pitch:** A cozy turn-based homestead puzzle where every act of care — planting, watering, harvesting,
crafting, delivering — costs one tick of the same scarce clock, so tenderness and efficiency are the
same decision.

| | |
|---|---|
| Genre | Turn-based resource puzzle / cozy farm management |
| Players | 1 (asynchronous competition via shared seeds and leaderboards) |
| Session length | 2–6 minutes (Journey stage), 6–10 minutes (Daily, Score Chase) |
| Platforms | Browser: desktop keyboard/mouse, phone/tablet touch, gamepad-navigable |
| Rendering | Three.js WebGL scene over a DOM HUD, plus a full DOM board mirror that keeps the game playable without WebGL |
| Persistence | `localStorage` for settings, progress and snapshots (offline cache); platform cloud save (zip+base64 slot) when hosted; server-side JSON for ranked boards in local dev |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Single-page shell: HUD status bar, two rails, playfield, tool tray, all 11 screens, live regions |
| `style.css` | Responsive grid shell, palette tokens, drawer behaviour, safe-area padding, screen overlays |
| `js/rules.js` | Deterministic rules engine (UMD: `window.MeadowRules` in the browser, `module.exports` on the server). Pure, serializable, no DOM |
| `js/render.js` | `window.MeadowRender` — Three.js scene, plot/crop meshes, selection and ghost layers, particles, quality tiers, palette shifts |
| `js/audio.js` | `window.MeadowAudio` — WebAudio buses, sampled one-shots with synth fallbacks, procedural ambience and music, caption dispatch |
| `js/main.js` | Bootstrap, session lifecycle, UI refresh, input (pointer/keyboard/gamepad), tutorial, screens, persistence, platform adapter |
| `server.js` | Authoritative server for local dev: static hosting plus `/api/v1` time, daily, scores (replay-validated), leaderboard, achievements, telemetry |
| `tests/rules.test.js` | 18 `node --test` rules/determinism/content-validation tests (`npm test`) |
| `tests/e2e.mjs` | Playwright playthrough of the real UI at desktop and mobile viewports (`npm run test:e2e`) |
| `tests/smoke.js` | Older manual smoke script kept for local debugging against a running server |
| `sfx/` | 15 Opus clips, `manifest.txt` (canonical), `manifest.md` (rendered table), `manifest.json` (generator input) |
| `assets/` | `title-keyart.webp`, `results-harvest.webp`, `soil-tile.webp` |
| `coverart.png` | 1200×675 StarHermit cover, derived from the title key art |
| `data/` | Server-owned, git-ignored: `leaderboard.json`, `achievements.json`, `excluded-days.json` |

---

## 2. Design pillars

**1. Every action costs a tick.** Plant, water, harvest, craft, fulfill and wait all advance time by exactly
one. Rules in tight, countable optimisation — the player can price the cost of kindness. Rules out idle
timers, real-time pressure and any "free" action; no move is correct to spam, no clock punishes thinking.

**2. Water is attention, and attention decays.** A crop grows only on ticks where it was watered and dies
after four unwatered ticks. Rules in a rhythm of rotating care and a real cost to over-planting. Rules out
fire-and-forget planting and any "grows while you're away" mechanic — the solo sim is frozen while the tab
is hidden, on purpose.

**3. Seasons are constraints, not decoration.** Season turns every 15 ticks (spring → summer → autumn) and
gates which crops may be planted; orders are generated only from in-season items, so demand is always
satisfiable. Rules in mid-session replanning; rules out weather RNG and unreachable demands.

**4. The canvas is beautiful, the DOM is authoritative.** Every plot exists twice — a 3D mesh and a labelled
button in `#board-mirror`. Rules in identical play for mouse, keyboard, screen reader and bot; rules out any
mechanic expressible only in 3D, and any state living in the renderer rather than the rules engine.

**5. Ranked means replayed.** A ranked score is a command log the server re-executes to the same state hash,
or it does not count. Rules in shared daily seeds and honest boards; rules out client-reported scores, hidden
randomness and any UI shortcut that mutates state outside `MeadowRules.apply`.

---

## 3. Player experience

**Target player.** Someone who likes a small daily optimisation puzzle shaped like a farm: the cozy surface
is real, but the pleasure is squeezing two more orders out of the same 90 ticks.

**First 60 seconds.** The title screen shows the homestead key art with Play, Daily Challenge, Journey
(labelled with the current stage), Profile, Help and Settings. Either path teaches:

- **Learn mode** (Modes → Learn) runs a five-step tutorial bubble anchored above the tool tray:
  plant → water → keep watering to harvest → fulfill an order → fulfill two to finish. Each step advances
  only when the matching command actually succeeds (`tutorialOnCommand`, `js/main.js`), so the player
  cannot skim past a mechanic without performing it. Every step is also read into `#live-objective`.
- **Journey stage 1** (the default one-click path from the title) is the tutorial-by-constraint: turnips
  only, no recipes, 8 plots, 2 orders, easy difficulty, 43 ticks. The Orders panel opens already asking for
  turnips, the Craft panel says "No recipes unlocked in this session", and the Hint button (`?`) names the
  single best next action in plain language.

By tick 3 the player has planted, watered and seen the crop change silhouette; by tick 8 they have filled an
order and heard the delivery bell. Help (from title or pause) is seven cards: goal, planting, watering,
harvest/craft, orders, controls, scoring.

**Session shape.** Pick mode → setup states the goal and whether it is ranked → a loop of plant/water/harvest
punctuated by a fulfilment every 5–10 ticks → season turns at ticks 15 and 30 force replanning → terminal →
results breakdown → retry, next stage, or home.

**Emotional beat.** The turn of the season: half the field becomes illegal to replant, the wind chime sounds,
and the plots filled two ticks ago read as either foresight or waste.

---

## 4. Core loop and rules contract

All rules live in `js/rules.js` and are shared verbatim by the client and `server.js`.

### Entities

- **Plot** — `{ crop: null | { type, age, watered, thirsty, ready } }`; `plotCount` is 8–16 in shipped
  configs, laid out 4 per row (`PLOT_COLS`, `js/render.js`).
- **Crops** (`CROPS`): turnip (grow 2, value 4, spring/autumn), carrot (grow 3, value 6, spring/summer),
  pumpkin (grow 5, value 10, summer/autumn). **Recipes** (`RECIPES`): Garden Salad = turnip + carrot, value
  14; Harvest Pie = 2 pumpkin + carrot, value 26.
- **Orders** — exactly `ACTIVE_ORDERS` = 3 live, each `{ id, needs, reward, score }`.
- **Seasons** — `seasonAt(tick) = [spring, summer, autumn][floor(tick/15) % 3]`.

### Legal actions

`check(state, cmd)` (`js/rules.js`) is the single legality authority; `legalActions(state)` enumerates it and
is used identically by the hint button, the tutorial, the content validator bot and the e2e test.

| Command | Legal when | Rejection reasons |
|---|---|---|
| `plant {plot, crop}` | crop known and in `allowedCrops`, plot in range and empty, crop's `seasons` include the current season | `unknown-crop`, `crop-not-unlocked`, `no-such-plot`, `plot-occupied`, `wrong-season` |
| `water {plot}` | plot holds a crop that is neither ready nor already watered | `no-such-plot`, `no-crop`, `already-grown`, `already-watered` |
| `harvest {plot}` | plot holds a crop with `ready` | `no-such-plot`, `no-crop`, `not-ready` |
| `craft {recipe}` | recipe in `allowedRecipes` and inventory covers `needs` | `unknown-recipe`, `recipe-not-unlocked`, `missing-ingredients` |
| `fulfill {orderId}` | order live and inventory covers `needs` | `no-such-order`, `missing-items` |
| `wait` | always (while not terminal) | — |

Any command in a terminal session returns `session-over`; a malformed one returns `malformed-command` or
`unknown-command`. Every reason has player-facing text in `ERROR_TEXT` (`js/main.js`), shown in the hint
banner and pushed to the assertive live region.

### Resolution order

`apply(prev, cmd)` (`js/rules.js`):

1. Reject a command with no string `id`, or an `id` already in `appliedIds` (`duplicate-command`) — this is
   what makes submission idempotent.
2. `check`. On failure: clone, increment `invalidActions`, emit `invalid`, and **return without advancing
   time**. The rejected command still mutated state, so `js/main.js` keeps it in the replay log; dropping it
   would diverge the client and server hashes.
3. Clone, apply the command's effect, emit its event (`planted`/`watered`/`harvested`/`crafted`/`fulfilled`/
   `waited`).
4. `advanceTime`: `tick += 1`, then for every plot **except the one just acted on** — a watered crop ages one,
   clears `watered`, resets `thirsty` and becomes `ready` at `age >= grow` (`grown`); an unwatered crop
   increments `thirsty` and is destroyed at `thirsty >= 4` (`withered`).
5. Push the command id (log capped at 512).
6. `finishIfTerminal`: `goal-complete` at `ordersFulfilled >= goalOrders`, else `time-up` at
   `tick >= maxTicks`; on terminal, freeze `state.score` and emit `terminal`.

Fulfilling removes the order, pays `reward` coins, adds `score`, and generates a replacement via `genOrder`,
so the board is never short of work.

### Scoring

```
orders    = Σ order.score for fulfilled orders      (order.score = reward × 10)
harvests  = harvestCount × 5
crafting  = craftCount × 15
coins     = coins
variety   = distinct item types ever produced × 25
timeBonus = goal-complete ? (maxTicks − tick) × 2 : 0
total     = orders + harvests + crafting + coins + variety + timeBonus
```

`computeScore`, `js/rules.js`. The HUD shows the running total minus the time bonus (which only exists on a
completed goal); the results table shows all six components and the frozen total.

**Worked example — Journey stage 1 (the e2e bot's real result).** 8 plots, turnips only, no recipes, goal 2
orders, `maxTicks` 43. The bot plants and waters two turnips, harvests both, and fulfills two orders paying 7
and 6, terminating at tick 11 with `goal-complete`: orders (7+6)×10 = **130**, harvests 2×5 = **10**, crafting
**0**, coins **13**, variety 1×25 = **25**, time bonus (43−11)×2 = **64** → **total 242**.

### Terminal states, tie-breaks, RNG

Terminal reasons are `goal-complete` and `time-up`; there is no lose state and no soft lock (the offline
validator proves this for every shipped config, §14). Board ties resolve in `compareRows`, `server.js`: higher
score → goal completed → fewer `invalidActions` → lower `elapsedMs` → stable `sessionId`.

No `Math.random` in the rules engine: `rngFloat(seed, stream, callIndex)` derives every value from FNV-1a
plus an xorshift, so the same seed and command order always produce the same orders. Only the `orders` stream
exists, and its call counter lives in state. Daily seeds are `dailySeed(date) = 'daily-<date>-<fnv36>'`,
immutable once published; the server re-derives them and rejects mismatches (`bad-daily-seed`).

### Undo and hints

Undo is an assist, enabled only where `config.assists.undo` is true (Practice, Learn). It pops a serialized
snapshot pushed before each successful command, rewinds, drops the last log entry, and rewrites the persisted
snapshot so a reload cannot resurrect the undone move. Ranked modes disable it and grey the button out.
Hints (`showHint`) never inspect hidden state: they read `legalActions(state)` and name the highest-priority
available action, in the order fulfill → harvest → water → craft → plant → wait.

---

## 5. Modes and progression

| Mode | Seed | Ticks | Goal | Field | Content | Assists | Ranked |
|---|---|---|---|---|---|---|---|
| Learn | `learn-seed` | 60 | 2 orders | 8 | turnip, carrot; no recipes | hints + undo | no |
| Journey | `journey-<n>` | 40 + 3n (cap 150) | 2 + ⌊n/2⌋ (cap 12) | 8 + ⌊n/3⌋ (cap 16); 8 on mastery stages | turnip → +carrot (4) → +pumpkin (9); salad (6), pie (12) | hints | no |
| Daily | `daily-<UTC date>-<hash>` | 100 | 8 orders | 12 | all | hints | **yes** |
| Practice | `practice-<random>` | 120 / 90 / 70 | 4 / 6 / 10 | 12 | all | hints + undo | no |
| Challenge | `challenge-blitz` / `-small` / `-nocraft` | 40 / 90 / 90 | 5 / 6 / 6 | 8 / 8 / 12 | nocraft variant removes recipes | hints | no |
| Score Chase | `scorechase-<UTC date>` | 120 | 10 orders | 12 | all, hard | hints | **yes** |

**Difficulty curve.** Difficulty lives in `genOrder`: `easy` orders name one item type and ask for 1–2;
`normal`/`hard` can name two types and ask for up to 3. Journey stages 1–7 are easy, 8–40 normal, and the tick
budget grows more slowly than the order goal, so pressure rises with stage number.

**Journey progression.** 40 stages from `journeyStage(n)`; mechanics arrive isolated then combine — turnips
alone (1–3), + carrots (4–5), + Garden Salad (6–8), + pumpkins (9–11), + Harvest Pie (12+). Every fifth stage
is a **mastery stage**: the field shrinks to 8 plots while the order goal climbs, testing rotation rather than
breadth. A stage unlocks the next only on `goal-complete`, and only when it is the player's current stage.

**Daily.** One shared UTC seed, replayable for a better score; completing it extends `dailyStreak` if the
previous completion was yesterday, else resets to 1.

**Unlocks.** Six achievements: First Harvest, Order Up, Homestead Kitchen (10 lifetime crafts), Seasoned Hand
(stage 10), Three Dawns (3-day streak), Homestead Restored (5000 lifetime coins). Unlocks are idempotent
locally and server-side, and gate nothing — they are badges on the Profile screen.

---

## 6. Controls and interaction

Play is always *select a tool, then apply it to a plot*. The tool tray is the mode selector; the plot is the
target. Re-clicking the active tool deselects it.

| Input | Desktop | Touch |
|---|---|---|
| Choose seed | keys `1`/`2`/`3`, or tray buttons | tap tray button |
| Water / Harvest | `W` / `H` | tap tray button |
| Apply tool to plot | click the 3D plot or its mirror button; or arrows to move selection + `Enter` | tap the 3D plot or its mirror button |
| Wait one tick | `Space` or the Wait button | Wait button |
| Fulfill order | Fulfill button in the Orders rail | open the 📋 drawer, then Fulfill |
| Craft | button in the Craft panel | open the 🎒 drawer, then the recipe |
| Undo / Hint | `U` / `?` or the tray buttons | tray buttons |
| Pause | `P`, `Esc`, or the Pause chip | Pause chip |
| Recentre camera | `C` | — (drag returns within bounds) |
| Orbit camera | drag on the canvas | drag on the canvas |
| Gamepad | d-pad/stick moves selection, A acts, B clears the tool, Start pauses | — |

**Gestures and input locking.** A drag becomes a camera orbit only past 24 px *and* 120 ms; below that it is
a tap on a plot, and camera x is clamped to ±4 world units. While any screen is open, gameplay keys are inert
and only `Esc` (back) is handled — `Esc` closes an open mobile drawer first, since the drawer overlays its own
toggle. `Enter`/`Space` on a focused button belongs to that button, so one keypress never both presses a
button and acts on a plot; a pointer click on a HUD button blurs it afterwards (keyboard-synthesised clicks
keep focus), so the next `Space` waits a tick.

**Feedback for every input.** Accepted → audio cue, particle burst at the plot, HUD re-render, polite
live-region line, 10 ms haptics where enabled. Rejected → `action-denied` cue, the specific reason in the hint
banner for 3 s, the same text in the assertive live region, `invalidActions` increments. Tool selection →
`.active` styling plus an announcement.

---

## 7. Screens and UI flow

Eleven sections inside `#screens`; at most one is `.open`. `showScreen` pushes onto `screenStack` and focuses
the first control, `backScreen` pops it; with an empty stack, back returns to play if a live session exists,
otherwise to the title. `#app[data-screen]` carries `boot` / `playing` / `screen`.

```
boot → (snapshot found?) → away ─┐
                                 ├→ title ──→ modes ──→ setup ──→ PLAYING ──→ results ──→ title | setup(next) | PLAYING(retry)
                                 └───────────┘                       │
                        title/pause → help, settings, profile        └→ pause → settings | help | restart | leave → title
                              play → leaderboard, friends
```

**Desktop (≥1024 px).** Three-column grid — objective/orders rail, playfield, inventory/craft/scores rail —
with the status bar above and tool tray below; rails always visible, drawer toggles hidden.

**Compact and portrait (<1024 px).** Both rails become fixed overlay drawers opened by the 📋 and 🎒 chips,
mutually exclusive, dismissed by tapping outside or `Esc`. The board mirror is *compacted, never hidden* on
phones (216 px, 4 columns) — it is the semantic control layer, and hiding it would leave plots reachable only
through the canvas.

**Landscape phone (≤500 px tall).** A narrow vertical status rail and scrolling vertical tool tray on the
left; the playfield takes the rest.

**Safe areas.** `--sat/--sab/--sal/--sar` from `env(safe-area-inset-*)` pad `#app`, the tool tray, the
tutorial bubble and every open screen; the meta tag sets `viewport-fit=cover`.

**Never cut off:** the status chips (season, tick, coins, score, mode), the whole tool tray, the board mirror,
the Fulfill button of any fulfillable order, and every button on an open screen (screens scroll rather than
clip). The results illustration is the one element that yields, hidden below 640 px of viewport height.

---

## 8. Art direction

**Palette** — CSS custom properties in `style.css`:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#eef5e8` | Page and screen ground (pale meadow) |
| `--panel` | `#ffffff` | Rails, cards, leaderboard rows |
| `--ink` | `#24301e` | All body text (contrast 12:1 on `--bg`) |
| `--accent` | `#3f7d3f` | Primary buttons, active tool, fulfillable order outline |
| `--accent-2` | `#d98e32` | Hint banner border |
| `--danger` | `#b13a3a` | Leave/destructive |
| `--chip` | `#dde8d2` | Status chips, secondary buttons |
| `--focus` | `#1a5fd7` | 3 px focus ring, offset 2 px |

High contrast mode swaps to `--bg #101010`, `--panel #1c1c1c`, `--ink #f5f5f5`, `--accent #7fd77f` and drops
the title key art for a flat ground.

**3D palette** (`SEASON_TINT`, `js/render.js`): spring sky `#bfe3ff` / ground `#7fbf5f`, summer `#a8d8ff` /
`#6fb84e`, autumn `#f3d9a4` / `#b99a4e`, each with matching fog so the horizon dissolves rather than ends.
Soil `#6b4a2e` dry / `#4a3018` watered (near-white multipliers once the soil texture loads), pond `#3f7fbf`,
cottage `#d9c8a8` walls with a `#a8543c` roof, fences `#9a7b52`.

**Shape language.** Rounded and low-poly, no sharp corners: box soil beds, cone sprouts, sphere roots, stacked
cone canopies, a cylinder-and-cone cottage, echoed in 10 px button radii, 999 px chips and a 12 px playfield
radius. Crops read at three growth stages by silhouette height (0.35 / 0.7 / 1.0) *before* they read by
colour, so growth stays legible in every accessibility palette. **Typography** is the system UI stack scaled
by `--text-scale` (1 or 1.25), with weight rather than family carrying hierarchy: 700 headlines, 600 buttons
and chips, 400 body, 0.85em `.fine`.

**Motion.** One dominant key light (`#fff3e0`, intensity 2.4) plus hemisphere fill; crops pop in on a 0.35 s
scale tween; selection ring and ready markers pulse; particle bursts are pooled and capped at 80 live meshes
(8 on plant/water, 12 on harvest). The camera is authored, never free: 38° perspective at (0, 12.5, 15),
orbit clamped to ±4 on x. **Hero of the screen:** in play, the field of plots at frame centre, everything else
a rail; on the title, the key art homestead; on results, the harvest still-life above the score table.

**Reduced motion.** `settings.reducedMotion` and the `prefers-reduced-motion` query kill all CSS transitions
and animations, suppress particle bursts (`burst` returns immediately), drop the crop scale-in tween, and
stop the idle pond/foliage and selection-ring animation in `frame`. Nothing is lost — every animated state
also has a static form (ring colour, mirror icon, live-region text).

**Visual assets the design calls for:** a title backdrop that says "restored homestead" before a word is
read, a results illustration that pays off the harvest, a topsoil texture so plots read as tilled earth
rather than brown boxes, and a cover matching the game's real palette. All four ship (§15).

---

## 9. Audio direction

**Mix philosophy.** A quiet afternoon: ambience continuous and low, music sparse enough to ignore, effects
the only layer that ever asks for attention — nothing loud enough to notice on the tenth session.

**Buses** (`js/audio.js`), independent `GainNode`s under a master gain with sliders in Settings: `music` 0.5,
`effects` 0.8, `ambience` 0.4, `voice` 0.8; mute zeroes all four without losing the stored values. The
`AudioContext` is created only on the first user gesture and clips are fetched lazily after it, so nothing
autoplays and a player who never presses a key downloads no audio.

**Music and ambience** are fully procedural: seeded pentatonic plucks (one note per 420 ms, a bass note every
8th step) over a filtered brown-noise wind bed with seeded bird chirps every 3–9 s. Both drop to a 2 s
heartbeat and stop rendering while the tab is hidden, and both derive from the session seed — two players on
the same daily hear the same birds. **One-shots** prefer the authored Opus sample mapped to their event and
fall back to the synth recipe while it loads or if it fails to decode, so a cue is never silent; `harvest`
alternates two clips by a seeded variant index. Every cue also dispatches a caption, shown in `#caption-line`
when captions are on.

### SFX event table

This table is the source of `sfx/manifest.txt`.

| event id | file | description | usage context |
|---|---|---|---|
| `click` | `ui-click.opus` | Short soft wooden UI tap, quick decay, no reverb tail | Confirmation tick after an accepted plot action |
| `plant` | `plant-seed.opus` | Seeds pattering into soft soil, ending in an earthy thud | `planted` event |
| `water` | `water-pour.opus` | Gentle sprinkle from a can rose, fading as soil soaks it | `watered` event |
| `harvest` | `harvest-pick.opus` | Leafy rustle and soft pop as a root comes free | `harvested` event (variant A) |
| `harvest` | `harvest-basket.opus` | Hollow knock of produce landing on wicker | `harvested` event (variant B) |
| `craft` | `craft-tap.opus` | Two mallet taps on wood and a soft fitting squeak | `crafted` event |
| `fulfill` | `order-fulfill.opus` | Small hand-bell rung twice, warm short ring-out | `fulfilled` event |
| `grown` | `crop-grown.opus` | Chime shimmer with rustling new leaves | `grown` event during tick resolution |
| `wither` | `crop-wither.opus` | Brittle papery rustle into a dusty sigh | `withered` event |
| `invalid` | `action-denied.opus` | Dull wooden thunk, muted and low | Any rejected command; pairs with the error banner |
| `pause` | `pause-menu.opus` | Single soft marimba note | Opening the pause screen |
| `terminal` | `session-complete.opus` | Ascending bell arpeggio, gentle not triumphant | `terminal` event under the results transition |
| `season` | `season-turn.opus` | Wooden wind chime and a distant leaf whoosh | Tick crosses a `SEASON_TICKS` boundary (`refreshAll`) |
| `undo` | `undo-rewind.opus` | Reverse whoosh with paper flutter | Undo in Practice/Learn |
| `achievement` | `achievement-unlock.opus` | Three rising glockenspiel notes with sparkle | First unlock of each achievement key (idempotent) |

---

## 10. Localization

**Required languages:** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.

**Where strings live today:** static labels in `index.html`; dynamic strings as template literals in
`js/main.js` (`ERROR_TEXT`, `objectiveText`, help cards, tutorial steps, results headlines, leaderboard notes,
mirror `aria-label`s) plus captions in `js/audio.js`. Crop and recipe display names live in `CROPS`/`RECIPES`
and reach the UI only through `itemName()` — the single translation seam for content.

**Language selection (design):** `navigator.languages`, narrowed to the shipped set with region fallback
(fr-CA → fr-FR → en-US), overridable from Settings and persisted in `settings.lang`.

**Expansion allowances:** German and French run 30–40% longer than English and the layout is built for it —
buttons size to content, rails are `minmax(200px, 260px)`, prose caps at 70ch and wraps, the tool tray wraps
to extra rows, and nothing is positioned by fixed pixel width. Numerals use `Intl.NumberFormat`; the daily
date stays a UTC ISO string in every locale, because it is also a seed component.

**Status:** the game currently ships US English only; `<html lang="en">` is static and there is no string
table. This is the one required feature that is designed but not implemented — see §17.

---

## 11. Accessibility

- **Keyboard-only play is complete**: skip link → tool keys `1`/`2`/`3`/`W`/`H` → arrows move the plot
  selection → `Enter` applies → `Space` waits → `U`/`?`/`P`/`C`. Orders, craft, boards and every screen
  control are real focusable buttons; nothing needs a pointer or the canvas, which is `aria-hidden="true"`
  and mirrored by `#board-mirror`.
- **Focus**: 3 px `--focus` ring at 2 px offset everywhere. Opening a screen focuses its first control and
  closing restores the previous one; because the mirror is rebuilt after every action, `updateBoardMirror`
  records and restores focus, following the current selection.
- **Announcements**: `#live-objective` (polite — session start, tool choice, plot description, hints,
  achievements), `#live-errors` (assertive — every rejection), `#live-score` (polite — results headline and
  total). Mirror buttons carry full labels: "Plot 3: Carrot, needs water (1/3)".
- **Captions**: every cue emits one, shown for 2 s in `#caption-line`, so wither and grown are never
  audio-only information.
- **Contrast and colour**: `--ink` is ~12:1 on `--bg` and ~14:1 on `--panel`; a high-contrast theme plus four
  colour-vision palettes (hue rotations in `adjustForPalette`) cover the 3D layer, where colour coding lives.
- **Reduced motion** and **Larger text** (1.25×) are Settings toggles, and the OS `prefers-reduced-motion`
  query disables animation on its own. Buttons, mirror cells and settings rows are ≥44×44 px on every
  viewport; left-handed mode flips the tool-tray direction.


## 12. StarHermit integration

`starhermit.txt` declares `name=Meadowstead`, `launch=index.html`, `server=server.js`, `cover=coverart.png`;
conventions follow https://wiki.starhermit.com/.

**Used (hosted, launch token):** the **launch token** arrives in the URL fragment `#game_token=<jwt>`, is read
once and stripped (`history.replaceState`); its payload gives `sub` and `game_scope` (the slug — never
hard-coded). `Authorization: Bearer <token>` rides on every REST call, re-minted every 45 min via
`POST /api/v1/games/{slug}/launch-token` (60 s retry on failure). **Identity** is the account nickname from
`GET /api/v1/users/{sub}/profile` (never `/api/v1/me`, never usernames; `"Player "+id8` fallback), shown in the
status-bar name chip, on the local board rows, and on the profile screen. **Cloud save**: one slot at
`GET`/`PUT /api/v1/me/cloud-saves/{slug}` as a stored zip (no compression) of `{progress, settings, snapshot}`
base64-encoded; loads prefer the remote copy on conflict, saves debounce 2 s and flush on `pagehide`, and a
sync chip (synced/saving/offline) sits in the status bar. `localStorage` remains the offline cache.
**Leaderboards** are read-only on-platform: `GET /api/v1/games/{slug}` → `leaderboardId`, then
`GET /api/v1/leaderboards/{leaderboardId}/entries?friendsOnly=` with userIds resolved to nicknames; friends
come from `GET /api/v1/me/friends`. Ranked results are kept as personal bests (local board + cloud save) —
clients never submit scores. **Achievements** stay local (part of the cloud-saved progress doc); this game's
server.js is not a Jint game script, so there is no script-owned unlock path.

**Used (local dev, no token):** `server.js` hosts the client and serves `/api/v1/{time,daily,scores,
leaderboard,achievements,telemetry}` same-origin; `/time` is probed on boot (round-trip-adjusted into
`platform.timeOffset`, so daily logic never reads the device clock); ranked rows are accepted only after the
server replays the command log to a matching initial hash, final hash and score; achievements are idempotent
per session id; telemetry is anonymous and best-effort. Query-param `?launchToken=`/`?token=` fallbacks exist
for local dev only. **Deliberately not used:** real-time multiplayer, matchmaking, chat and purchases.
Meadowstead is a solo puzzle whose only shared surface is a seed and a score.

**Offline is a first-class path.** With no token (or unreachable dev server), `platform.hosted` stays false:
play is identical, ranked scores are replayed locally onto a casual local board, and the leaderboard screen
says plainly that the rows are offline and local.


## 13. Technical architecture

**Module boundaries.** `rules.js` knows nothing of the DOM, `THREE` or audio and is loaded unchanged by Node
on the server — that is what makes authoritative replay possible. `render.js` is a pure projection of rules
state: `sync` diffs a per-plot key (`crop|stage|ready`) and rebuilds only what changed. `audio.js` owns the
`AudioContext` and nothing else. `main.js` is the only module touching `localStorage`, `fetch` or the DOM.

**Determinism and replay.** State is plain JSON and `stableStringify` sorts keys before hashing, so
`stateHash` is order-independent. The results envelope carries `{schemaVersion, contentVersion, build, mode,
seed, config, commands, initialHash, finalHash, terminalReason, score, invalidActions, elapsedMs, sessionId}`;
the client replays it before writing a local row, the server before accepting a ranked one. Rejections are
explicit: `stale-schema-version`, `stale-content-version`, `bad-daily-seed`, `day-excluded-from-ranking`,
`initial-hash-mismatch`, `final-hash-mismatch`, `score-mismatch`, `session-not-terminal`, `payload-too-large`,
`bad-command-log`.

**Persistence.** `meadowstead:settings`, `:progress`, `:funnel` (last 200 events) and `:snapshot`. The
snapshot is rewritten after every command — rejected ones and undos included — and carries `elapsedMs`, so a
resumed session keeps its true duration for tie-breaks. On boot a non-terminal snapshot opens "Welcome back";
`migrate()` accepts only the current schema, and a `deserialize` failure deletes the snapshot rather than
trapping the player on a broken save. Server-side, JSON is written atomically (temp + rename) into `data/`,
which the static handler refuses to serve; per-IP buckets rate-limit scores (20/min), achievements (60/min)
and telemetry (120/min); path traversal is blocked by a `ROOT + sep` prefix check.

**Performance.** Quality tiers low (DPR 1, no shadows/particles, 0.85 render scale), medium (DPR 1.5,
shadows, 200 particles) and high (DPR 2, shadows, 600), with a hard cap of 80 live particle meshes. A hidden
tab renders nothing and drops audio timers to a 2 s heartbeat. Context loss cancels the loop; restore rebuilds
the renderer from CPU-side descriptors and re-syncs instantly. Without WebGL, `#webgl-fallback` says the game
stays fully playable through the field controls — and it is.

**How the e2e drives the real UI.** `tests/e2e.mjs` starts its own static server on an ephemeral port, stubs
`/api/v1`, and launches system Chrome with swiftshader. It picks each move with the validator bot's greedy
strategy, reading state from the game's *own persisted snapshot*, then performs it through real UI — tool
buttons and mirror clicks on desktop; tool keys and arrow/Enter navigation on mobile, where it must also open
the orders drawer to reach a Fulfill button. It never calls game internals to change state.


## 14. Testing and acceptance criteria

**`npm test`** — 18 tests in `tests/rules.test.js`, all passing: deterministic replay (same seed + commands ⇒
same hashes, different seeds diverge); the plant → water → harvest lifecycle, season legality (pumpkin is
illegal in spring), withering after `WITHER_TICKS`, and craft/fulfil bookkeeping; invalid actions incrementing
the counter **without consuming a tick** and duplicate ids rejecting idempotently; both terminal states with a
full score breakdown; serialization round-trip, migration guards and a fuzz pass proving malformed commands
never hang or corrupt state; content validation proving **all 40 journey stages** and a **full year of daily
seeds** solvable and bounded by the `validateContent` bot (no soft locks, no unreachable orders) while broken
configs are rejected; golden easy/normal/hard sessions terminating with sane scores; the hint API using
exactly the play-time legal-action list; and daily seeds stable per date, distinct across dates.

**`npm run test:e2e`** — two passes (desktop 1280×800, mobile 390×844 touch), both passing: title → Journey
setup showing "Stage 1/40" → session with 8 plots at `Time 0/43` → a full greedy playthrough via real controls
to results → 6 breakdown rows, a `goal-complete` headline, `journeyStage` advanced to 2 → retry, plant by
keyboard, hint banner → snapshot `elapsedMs` surviving a reload through "Welcome back" → pause/resume →
settings open, reduced motion applied, close → leave to title. **Any page error or non-benign console error
fails the run.**

**QA bar** (`agents/qa.md`), as checkable statements:

1. A first-time player is taught — Learn gates on performing each mechanic, Journey stage 1 restricts the game
   to one crop, `?` names the best next action at any moment. ✅
2. Every implemented feature is reachable in the browser: six modes, undo, hints, pause, settings, help,
   profile, achievements, three leaderboard tabs, friends, seed sharing, resume. ✅
3. No console errors or warnings in either e2e pass (benign swiftshader GPU messages are the only filter). ✅
4. Nothing is cut off at 1280×800 or 390×844 portrait; screens scroll rather than clip, and the results
   illustration drops below 640 px of height so the score table always fits. ✅
5. Platform APIs are used where they apply: hosted — launch token (fragment, Bearer, 45-min refresh), profile
   nickname, cloud save slot, read-only leaderboard + friends; local dev — time, replay-validated scores,
   leaderboards, achievements, telemetry. ✅
6. Localization: **not met** — see §17.

**Acceptance for any change:** `node --check` passes on every JS/MJS file, `npm test` is green,
`tests/e2e.mjs` is green at both viewports, the asset audit passes, and this document is updated in the same
commit as any observable behaviour change.


## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-keyart.webp` | Title/menu backdrop (1536×864) behind a page-coloured scrim | FLUX.2 klein, seed 71120, 30 steps | generated this pass; wired in `style.css` |
| `assets/results-harvest.webp` | Results-screen harvest still-life (1024×576) | FLUX.2 klein, seed 30507, 30 steps | generated this pass; wired in `index.html` (`#results-art`) |
| `assets/soil-tile.webp` | Tilled-topsoil map for plot soil materials (512×512) | FLUX.2 klein, seed 90211, 30 steps | generated this pass; wired in `js/render.js` (`loadSoilTexture`, flat-colour fallback) |
| `coverart.png` | StarHermit cover (1200×675) | Derived from `title-keyart` | regenerated this pass, replacing a generic placeholder |
| `favicon.svg`, `icon.png` | Browser and platform icons | authored | shipped |
| `vendor/three.module.min.js`, `vendor/three.core.min.js` | Three.js r185 | upstream | shipped |
| `sfx/*.opus` (12 clips: click, plant, water, harvest ×2, craft, fulfill, grown, wither, invalid, pause, terminal) | one-shot cues, see §9 | MOSS-SFX v2.0 | shipped |
| `sfx/season-turn.opus` | `season` cue | MOSS-SFX v2.0, 100 steps | generated this pass; bound in `js/audio.js`, fired from `refreshAll` |
| `sfx/undo-rewind.opus` | `undo` cue | MOSS-SFX v2.0, 100 steps | generated this pass; bound to `session.undo` |
| `sfx/achievement-unlock.opus` | `achievement` cue | MOSS-SFX v2.0, 100 steps | generated this pass; bound to `unlockAchievement` |

No 3D model or character animation assets: the homestead is built from parametric primitives at runtime and
there is no humanoid character to animate, so neither TRELLIS nor Kimodo has a subject here.

---

## 16. Known limitations

- **No localization.** English only; `<html lang="en">` is fixed and strings are inline (see §17).
- **Music and ambience are procedural**, not authored: seeded and pleasant, but they do not vary by season or
  by proximity to the goal. **Camera orbit is x-only**, clamped to ±4 — no pitch, zoom or rotation.
- **The local casual board is self-reported** — plausibility-checked by local replay, but editable via
  `localStorage`. Only the server board is trustworthy, which is why each board labels its provenance.
- **The friends list is local-only offline**: without a launch token, names are typed by hand and a friend's
  score shows only if it was recorded on this device. Hosted, friends come from the platform account.
- **Server storage is flat JSON files**, 100 rows per board, with no pruning of old daily boards.
- **Undo is single-branch** and is not part of the snapshot, so a resumed session starts with an empty stack.
- **`tests/smoke.js` is stale** — a fixed-port manual debugging script; `tests/e2e.mjs` is authoritative.

---

## 17. Design intent not yet implemented

1. **Localization to the nine required locales.** §10 specifies the seam — `itemName()` for content, a string
   table for UI prose, `navigator.languages` with region fallback, a `settings.lang` override, and expansion
   headroom already present in the layout. The string table, picker and translations do not exist yet.
2. **Season-adaptive music.** The audio design wants the music bed to shift instrument and tempo with the
   season and to lift as the order goal approaches. Today the music is one seeded pentatonic pattern at a
   constant 420 ms step for the whole session.
3. **Season-specific 3D dressing.** `SEASON_TINT` recolours sky, fog and ground, but tree canopies and the
   cottage do not change with the season, so autumn reads as a colour grade rather than a different field.
