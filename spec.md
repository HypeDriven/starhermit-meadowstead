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
| Platforms | StarHermit engine script game (engine 1.28.0, `engine.minor=30`): natively in the StarHermit client, in browsers through the engine's web runtime; keyboard, mouse, touch and gamepad |
| Rendering | `starhermit:scene` (the old three.js scene, ported) behind a `starhermit:ui` HUD, plus an accessible plot mirror that plays the whole game |
| Persistence | The game's save (`starhermit:storage` `saves`: on the device and in the player's cloud slot), engine settings for the game's options |

### File map

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: entry `native/main.ts`, engine 1.28.0 / minor 30, capabilities `platform,storage,clipboard`, `control.*` and `engine.gamepad.*` |
| `native/main.ts` | Entry: session (commands, undo, replay log and envelope, snapshot, tutorial, achievements, journey/daily progress, local board, leaderboard post), screen stack, input |
| `native/screens.ts` | Every screen and the play layout (status bar, rails or drawers, tool tray, plot mirror, banners) |
| `native/render.ts` | The homestead scene, camera fitted into the playfield, picking |
| `native/audio.ts` | Sample one-shots, rendered music plucks, wind loop and chirps, captions |
| `native/platform.ts` | Save, options, foreign-save and settings-KV migration, player, clock, friends, leaderboards |
| `native/quality.ts`, `native/style.ts`, `native/i18n.ts`, `native/classic.ts` | Look per graphics level, UI styles, localization, the classic scripts |
| `js/rules.js` | Deterministic rules (UMD; shared with `server.js` and the Node tests) |
| `js/progress.js` | The save document: merge, foreign read, option picking (pure) |
| `js/strings.js`, `js/i18n.js`, `js/sh-strings.js` | Translation tables and lookup; StarHermit account strings |
| `assets/` | Title key art, results art, soil tile, baked textures (`assets/textures/`), `ui-style.json` |
| `sfx/` | Authored one-shots (`manifest.json` lists prompts) |
| `score-script.js` | Platform server script: range-checks and posts `high-score` |
| `server.js` | Local dev static server with replay-validated score API (not packaged) |
| `index.html`, `starhermit-files.json` | Web loader and file index written by `npm run package` (never edited by hand) |
| `tools/` | `package-web`, `css`, `gen-plays`, `bake-textures`, `browser-play` |
| `tests/` | Node unit tests, `native.mjs` engine checks, `native/*.play` scripts |

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

**4. The canvas is beautiful, the mirror is authoritative.** Every plot exists twice — a 3D mesh and a labelled
button in the plot mirror. Rules in identical play for mouse, keyboard, screen reader and bot; rules out any
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

- **Learn mode** (Modes → Learn) runs a five-step tutorial bubble above the plot mirror:
  plant → water → keep watering to harvest → fulfill an order → fulfill two to finish. Each step advances
  only when the matching command actually succeeds (`tutorialOnCommand`, `native/main.ts`), so the player
  cannot skim past a mechanic without performing it. Every step is also announced to screen readers.
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
  configs, laid out 4 per row (`PLOT_COLS`, `native/render.ts`).
- **Crops** (`CROPS`): turnip (grow 2, value 4, spring/autumn), carrot (grow 3, value 6, spring/summer),
  pumpkin (grow 5, value 10, summer/autumn). **Recipes** (`RECIPES`): Garden Salad = turnip + carrot, value
  14; Harvest Pie = 2 pumpkin + carrot, value 26.
- **Orders** — exactly `ACTIVE_ORDERS` = 3 live, each `{ id, needs, reward, score }`.
- **Seasons** — `seasonAt(tick) = [spring, summer, autumn][floor(tick/15) % 3]`.

### Legal actions

`check(state, cmd)` (`js/rules.js`) is the single legality authority; `legalActions(state)` enumerates it and
is used identically by the hint button, the tutorial, the content validator bot and the play-script generator.

| Command | Legal when | Rejection reasons |
|---|---|---|
| `plant {plot, crop}` | crop known and in `allowedCrops`, plot in range and empty, crop's `seasons` include the current season | `unknown-crop`, `crop-not-unlocked`, `no-such-plot`, `plot-occupied`, `wrong-season` |
| `water {plot}` | plot holds a crop that is neither ready nor already watered | `no-such-plot`, `no-crop`, `already-grown`, `already-watered` |
| `harvest {plot}` | plot holds a crop with `ready` | `no-such-plot`, `no-crop`, `not-ready` |
| `craft {recipe}` | recipe in `allowedRecipes` and inventory covers `needs` | `unknown-recipe`, `recipe-not-unlocked`, `missing-ingredients` |
| `fulfill {orderId}` | order live and inventory covers `needs` | `no-such-order`, `missing-items` |
| `wait` | always (while not terminal) | — |

Any command in a terminal session returns `session-over`; a malformed one returns `malformed-command` or
`unknown-command`. Every reason has player-facing text in `ERROR_TEXT` (`native/main.ts`), shown in the hint
banner and pushed to the assertive live region.

### Resolution order

`apply(prev, cmd)` (`js/rules.js`):

1. Reject a command with no string `id`, or an `id` already in `appliedIds` (`duplicate-command`) — this is
   what makes submission idempotent.
2. `check`. On failure: clone, increment `invalidActions`, emit `invalid`, and **return without advancing
   time**. The rejected command still mutated state, so `native/main.ts` keeps it in the replay log; dropping it
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

**Worked example — Journey stage 1 (the play-script bot's real result, `tests/native/journey-stage-1.play`).** 8 plots, turnips only, no recipes, goal 2
orders, `maxTicks` 43. The bot plants and waters two turnips, harvests both, and fulfills two orders paying 7
and 6, terminating at tick 11 with `goal-complete`: orders (7+6)×10 = **130**, harvests 2×5 = **10**, crafting
**0**, coins **13**, variety 1×25 = **25**, time bonus (43−11)×2 = **64** → **total 242**.

### Terminal states, tie-breaks, RNG

Terminal reasons are `goal-complete` and `time-up`; there is no lose state and no soft lock (the offline
validator proves this for every shipped config, §14). The dev `server.js` breaks board ties in `compareRows`: higher score → goal completed → fewer
`invalidActions` → lower `elapsedMs` → stable `sessionId`.

No `Math.random` in the rules engine: `rngFloat(seed, stream, callIndex)` derives every value from FNV-1a
plus an xorshift, so the same seed and command order always produce the same orders. Only the `orders` stream
exists, and its call counter lives in state. Daily seeds are `dailySeed(date) = 'daily-<date>-<fnv36>'`,
immutable once published; the dev server re-derives them and rejects mismatches (`bad-daily-seed`).

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
and gate nothing — they are badges on the Profile screen.

---

## 6. Controls and interaction

Every action is a runtime action (`starhermit.txt`), rebindable in the StarHermit Options (Settings →
Keyboard bindings opens the rebind dialog).

| Action | Keyboard | Gamepad |
|---|---|---|
| Move plot selection (wraps; up/down jump a row of 4) | ← → ↑ ↓ | D-pad / left stick |
| Use the current tool on the selected plot | Enter | South |
| Turnip / Carrot / Pumpkin seeds | 1 / 2 / 3 | Left shoulder / right shoulder / left trigger |
| Water / Harvest | W / H | North / West |
| Wait one tick | Space | Right trigger |
| Undo (Practice, Learn) | U | Select |
| Pause | P | Start |
| Hint | / | Right stick press |
| Reset camera | C | Left stick press |
| Back (closes a screen; in a round closes a drawer, else pauses) | Escape | East |

Pressing a tool's key while it is the current tool puts it down; with no tool, using a plot just selects it.
With a widget focused (Tab), the arrows, Enter and Space belong to the UI; a click or tap on a HUD button
hands them back to the field.

**Pointer and touch.** Tap a tool in the tray, then a plot — either in the 3D field (a click or tap selects the
plot under it and applies the tool) or in the plot mirror. Hovering the field shows the hover ring and the
tool's legal-target ghost (green legal, red not). A press that moves more than 24 px after 120 ms orbits the
camera sideways (clamped to ±4). Presses on widgets are the widgets', decided after the frame's UI is built.

## 7. Screens and UI flow

Screens form a stack (Escape or ← Back/← Done pops it): **Title** (key art; ▶ Play, 📅 Daily Challenge with
the next-seed countdown, 🗺 Journey with the current stage, 👤 Profile, ❓ Help, ⚙ Settings, and Sign in with
StarHermit / Invite a friend) → **Modes** (six mode cards) → **Setup** (goal and ranking text; Practice
difficulty and Challenge variant selects; Start) → **Play** → **Results** (art, headline, six-row score
breakdown and total, leaderboard line, newest achievement; ↻ Retry, Next → on a completed Journey stage,
Home). **Pause** (▶ Resume, Settings, Help, Restart, 🚪 Leave), **Settings**, **Help** (seven cards),
**Leaderboards** (Global / Daily / Friends tabs), **Friends**, **Profile** (summary, achievements, mastery
track) and **Welcome back** (a saved round found at start) open over the dimmed field.

**Play layout** (picked by the window's logical size, the old CSS breakpoints):
- *Desktop* (≥ 1024 px wide): status chips across the top (season, time, coins, score, mode, player and
  cloud-save chips when signed in, Pause), the left rail (Objective with progress bar, Orders with Fulfill
  buttons, outlined when fulfillable), the right rail (Inventory, Craft buttons, Scores → Leaderboards and
  Friends), the field between, the tool tray below (labels with the bound key).
- *Compact* (< 1024 px): the rails become full-height drawers opened by 📋 / 🎒 in the status bar; a tap
  outside (or Escape) closes them.
- *Portrait phone* (≤ 700 px wide): three tools a row, no key hints, a smaller plot mirror.
- *Landscape phone* (≤ 500 px tall): status column left, the field centre, tools as a scrolling right column.

Over the field: the hint/error banner (top, 3 s for errors, 6 s for hints), the plot mirror (bottom-left; one
button per plot: ▫ empty, 🌱 growing, 💧 watered, 🌟 ready, the selection outlined), the caption line
(bottom-right), and in Learn the tutorial bubble (above the mirror; at the field's top on landscape phones)
with Skip tutorial. Toasts (copied links, sign-out) show at the bottom.

## 8. Art direction

The homestead is the browser build's three.js scene on `starhermit:scene`: seasonal sky, fog and meadow
tints (`SEASON_TINT`, hue-shifted by the colour palette option), a clear-coated pond with pulsing ripple
rings, seven seeded cone trees, the farmhouse with chimney, door and glowing windows, the fence, seeded
grass tufts, wildflowers and pond stones, timber bed frames, the authored soil tile (darker when watered),
crops per stage (sprout cones, leafy stems, clear-coated bulbs and pumpkins) with a bright ready ring that
blooms, selection/hover rings, the ghost disc, burst specks and pollen motes. Lights, the shadow box and the RoomEnvironment (lowered as r183+) are the page's own.

**Graphics levels.** The runtime's quality tier (Options › Graphics) picks the old preset table
(`native/quality.ts`): Low — Lambert shading, no shadows, MSAA, plain scenery; Balanced — Standard shading,
1024 shadows, bloom, grade, FXAA, reflections (RoomEnvironment, intensity 0.28), scenery detail; High —
physical (clear-coat) shading, 2048 shadows, GTAO, SMAA, pollen motes; Ultra — 4096 shadows, high GTAO,
full-resolution bloom and AO, MSAA. Tuft and mote budgets grow within a tier with the level (≤ 2×). The
meadow luminance texture and the ripple normal map are baked per budget (`tools/bake-textures.mjs`, from
the old canvas painters). Render scale, adaptive resolution, frame-rate limit and FPS readout are the
runtime's. The camera keeps the playfield's aspect (widening the field of view below 0.85) and is offset into
the playfield's rectangle (`setViewOffset`), the page colour painted around it with rounded corners.

**UI.** `tools/ui-style.css` (the old `style.css` rewritten class-based, `npm run css`) → `assets/ui-style.json`:
pale green page, white panels, sage chips and buttons, green primary, red danger, blue focus ring. Emoji
icons draw in colour from the engine's StarHermit Emoji.

## 9. Audio direction

Authored one-shots (`sfx/*.opus`) per event — click, plant, water, harvest (two seeded variants), craft,
fulfill, grown, wither, invalid, pause, terminal, season turn, undo, achievement — each with a caption
(Settings → Captions). Music: seeded pentatonic sine plucks every other 420 ms step and a low note every
eighth; ambience: a looped filtered-noise wind and seeded bird chirps every 3–9 s. Plucks, wind and chirp are
rendered into clips once (no live synthesis graph). Buses: music → music; effects and ambience → effects;
the click → interface. Volumes, mute and the voice limit are the runtime's Options. A hidden window holds the
music and ambience.

## 10. Localization

Nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT), English source strings as keys
(`js/strings.js`; en-GB, es-ES and fr-CA list differences). The language is the runtime's interface language
(Options › Language, else the account's or device's); every string is drawn through `T()` each frame, so a
change shows at once. `tests/i18n.test.mjs` checks every key the client shows is translated, placeholders and
markup survive, and no table keeps unused keys.

## 11. Accessibility

Every widget is in the runtime's accessibility tree (screen readers; browser automation by role): the plot
mirror's buttons carry full plot descriptions ("Plot 3: Carrot, needs water (1/3), selected"), Fulfill and
Craft buttons say what they need, and state changes, refusals, hints and tutorial steps are announced.
Runtime Options cover reduced motion (stops tweens, particles, sway and pulses), high contrast (dark tokens;
the title art is dropped), larger text and UI scale. Game options (Settings): colour palette (default,
deuteranopia, protanopia, tritanopia, high-contrast scene tints), left-handed tool tray (reversed), haptics
(a short vibration on a successful plot action), captions.

## 12. StarHermit integration

- **Save.** `{ v: 1, progress, snapshot }` in `saves` (schema 1): progress after every change, the round
  snapshot after every command (a quit or reload resumes at "Welcome back"). Conflicts merge with
  `mergeSaves` (journey stage and counters max, achievements earliest, dailies and friends united, local
  board best 50; this device's round kept).
- **Migration.** The browser build's cloud slot (`game:<slug>`, the JS SDK's JSON document) shows as a
  foreign save: its progress and round are merged in once and the slot replaced; its game options (palette,
  left-handed, haptics, captions) and the tutorial flag are adopted where not set. The old settings-KV keys
  are migrated the same way, then all removed. Guests' old browser `localStorage` progress cannot migrate.
- **Leaderboards.** Ranked runs (Daily, Score Chase) post their total to the `high-score` board through
  `score-script.js` (a practice session whose socket carries `{ type: 'result', scores }`); the results show
  the rank. Results are server-authoritative in that only the script writes the board (range-checked client
  total, as before; the user's policy keeps solo scores on score-script.js). Every ranked run also lands on
  the local board after a local replay check. The Leaderboards screen reads the platform board signed in
  (Daily stays local: the platform board is a single global board), the local board otherwise.
- **Friends** come from the account (with presence and their best score) when signed in; guests keep a typed
  local list. **Invite a friend** copies the platform invite link; **Copy today's challenge seed** copies the
  daily seed (`clipboard`).
- **Clock.** The Daily and Score Chase seeds and the streak use the platform's `serverNow()`, falling back to
  the device clock offline.
- Sign-in is the runtime's Account dialog; a session ending (sign-out, elsewhere) shows a toast and play
  continues locally.

## 13. Technical architecture

`native/main.ts` loads `js/rules.js`, `js/strings.js` and `js/i18n.js` as classic scripts (`loadClassic`), so
the shipped rules are the ones Node tests and `server.js` run. The session keeps the command log and builds
the old replay envelope (hashes, config, commands) at the end; the local board replays it before recording.
Command ids use the wall clock (uniqueness only); the rules are seeded and deterministic. Rendering reads
rules state each frame and never writes it. Analytics stay a local 200-entry funnel in device storage
(no endpoint).

## 14. Testing and acceptance criteria

- `npm run test:unit`: rules (`tests/rules.test.js`, including the content validator over every shipped
  config), save document (`tests/save.test.mjs`), localization (`tests/i18n.test.mjs`).
- `npm run test:native` (`tests/native.mjs`): web index matches the files, `tsc` against the host API types,
  `starhermit check .` with zero warnings, and every `tests/native/*.play` as a guest render check:
  `learn.play` and `journey-stage-1.play` (desktop, the full round by keyboard and Fulfill clicks to results),
  `challenge-phone.play` (390 × 844, touch, drawers, pause, leave), `landscape.play` (844 × 390, variant select by
  keyboard, hint, restart, leave), `menus.play` (960 × 540: Help, Settings, Profile, Practice with undo,
  Leaderboards, Friends with typing, pause). Scripts come from `tools/gen-plays.mjs` (the rules bot).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in GPU Chrome at desktop, phone (DPR 3)
  and landscape phone (DPR 3): the Learn lesson to its results by keys (desktop) or taps (phones), then on the
  desktop a click on a 3D plot, a camera drag, C and pause; no console errors or warnings.
- `npm run package` after every change (the native test fails on a stale index).

## 15. Asset inventory

`assets/title-keyart.webp`, `assets/results-harvest.webp`, `assets/soil-tile.webp`, `assets/textures/grass-*.png`
and `ripple-*.png` (baked), `sfx/*.opus` (15 one-shots), `cover.jpg`, `icon.png`.

## 16. Known limitations

- **Music and ambience are procedural**, not authored, and do not vary by season. **Camera orbit is x-only**,
  clamped to ±4.
- **The local board is self-reported** (plausibility-checked by local replay); only the platform board is
  trustworthy, and solo leaderboard scores are the client's total range-checked by `score-script.js`.
- **Undo is single-branch** and not part of the snapshot: a resumed round starts with an empty undo stack.
- The browser build's per-category graphics overrides, its own volume/mute/language panels and the dead
  "Hold to confirm" and "Timing assistance" toggles (they never changed play) are gone: the runtime's
  Options own sound, graphics, language and accessibility.
- Samples still loading are silent (the old synthesized fallbacks are not ported); their captions still show.
- Signed-in paths (cloud merge, foreign migration, leaderboard posting, friends) are covered by unit tests,
  not live-tested here.

## 17. Design intent not yet implemented

1. **Season-adaptive music** that shifts instrument and tempo with the season and lifts near the goal.
2. **Season-specific 3D dressing** beyond the sky, fog and ground tints.
