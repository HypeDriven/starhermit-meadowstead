// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event with the seeded variant
// pick for the harvest, the soft pentatonic plucks of the music (a note every
// other 420 ms step, a low note every eighth, both seeded by the session), the
// meadow ambience (a two-second filtered-noise wind loop and seeded bird
// chirps every 3–9 s), plus the captions every cue emits.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu click → "interface"; the old default bus
// levels (music 50 %, effects 80 %, ambience 40 %) are folded into each sound's
// gain. The plucks, the wind and the chirp are rendered into clips once
// (createClip): a live synthesis graph makes clip loads fail on the engine's
// web runtime. The synthesized stand-ins the browser build played while a
// sample decoded are not ported, so a sample still loading is silent (its
// caption still shows). Clips load once the mixer runs (natively at once, in a
// browser after the first press), one at a time; rendered clips one a frame.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.5, effects: 0.8, ambience: 0.4 };
/** audio.js SAMPLE_MAP. */
const SFX: Record<string, string[]> = {
  click: ["ui-click"], plant: ["plant-seed"], water: ["water-pour"], harvest: ["harvest-pick", "harvest-basket"],
  craft: ["craft-tap"], fulfill: ["order-fulfill"], grown: ["crop-grown"], wither: ["crop-wither"], invalid: ["action-denied"],
  pause: ["pause-menu"], terminal: ["session-complete"], season: ["season-turn"], undo: ["undo-rewind"], achievement: ["achievement-unlock"],
};
/** audio.js caption keys (translated where shown). */
export const CAPTIONS: Record<string, string> = {
  click: "click", plant: "planting", water: "watering", harvest: "harvest", craft: "crafting", fulfill: "order fulfilled",
  grown: "a crop is ready", wither: "a crop withered", invalid: "action not allowed", terminal: "session complete",
  season: "the season turns", undo: "action undone", achievement: "achievement unlocked",
};

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let seed = "audio";
let variantCalls = 0;
let captionFn: ((text: string) => void) | null = null;

function fnv(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** audio.js variant(): seeded 0.9 … 1.1 so replays sound identical. */
function variant(): number { return 0.9 + fnv(seed + "|" + (variantCalls++)) % 1000 / 5000; }

/** The caption line's listener (English keys, translated where shown). */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }
/** audio.js setSeed: a session's seed drives the variants, the music and the chirps. */
export function setSeed(s: string): void { seed = String(s); }

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** A game event's sample (once loaded) and its caption. */
export function sfx(event: string): void {
  const cap = CAPTIONS[event];
  if (cap && captionFn) captionFn(cap);
  const names = SFX[event];
  if (!names || suspended) return;
  const file = names[Math.floor(variant() * 1000) % names.length]!;
  const clip = clips.get(file);
  if (!clip) return;
  const bus: Bus = event === "click" ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

// -- rendered clips -------------------------------------------------------------------
const RATE = 22050;
/** audio.js tone(bus, f, dur, 'sine', gain[, slideTo]): gain then an exponential ramp to 0.0001 over dur. */
function toneClip(freq: number, dur: number, gain: number, slideTo?: number): AudioClip {
  const n = Math.round((dur + 0.02) * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur, i / RATE);
    const f = slideTo ? freq * Math.pow(slideTo / freq, t / dur) : freq;
    phase += 2 * Math.PI * f / RATE;
    out[i] = Math.sin(phase) * gain * Math.pow(0.0001 / gain, t / dur);
  }
  return createClip([out], RATE);
}
/** audio.js startAmbience: two seconds of leaky-integrated noise (×4) through a 400 Hz low-pass at gain 0.5, looped. */
function windClip(): AudioClip {
  const n = 2 * RATE;
  let s = fnv("meadow-wind");
  const rnd = (): number => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const a = 1 - Math.exp(-2 * Math.PI * 400 / RATE);
  const noise = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) { v = v * 0.98 + (rnd() * 2 - 1) * 0.02; noise[i] = v * 4; }
  const out = new Float32Array(n);
  let y = 0, y2 = 0;
  // Two passes of a two-pole low-pass (the biquad's stand-in), warmed over the loop once so the seam is quiet.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      y += a * (noise[i]! - y);
      y2 += a * (y - y2);
      if (pass === 1) out[i] = y2 * 0.5;
    }
  }
  return createClip([out], RATE);
}

// -- music and ambience -------------------------------------------------------------------
const SCALE = [262, 294, 330, 392, 440, 523, 587, 659];
const CHIRP_BASE = 1800;
const plucks = new Map<number, AudioClip>();
const lows = new Map<number, AudioClip>();
let wind: AudioClip | null = null;
let chirp: AudioClip | null = null;
let windSound: Sound | null = null;
let started = false;
let musicStep = 0;
let nextStep = 0;
let chirpCount = 0;
let nextChirp = 0;

/** audio.js resume(): ambience and music run from the first press on (and from boot natively). */
export function start(): void { started = true; }
/** A hidden window: the music and ambience hold (audio.js stopped its timers). */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame: the samples once the mixer runs (one at a time), the rendered clips one a frame after them, then
 * the wind by state and the music's and chirps' next steps by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const names of Object.values(SFX)) for (const n of names) load(n);
    return;
  }
  pump();
  if (loading || queue.length) return;
  if (!wind) { wind = windClip(); return; }
  if (!chirp) { chirp = toneClip(CHIRP_BASE, 0.09, 0.05, CHIRP_BASE * 1.3); return; }
  for (const f of SCALE) if (!plucks.has(f)) { plucks.set(f, toneClip(f, 0.5, 0.05)); return; }
  for (const f of SCALE.slice(0, 4)) if (!lows.has(f)) { lows.set(f, toneClip(f / 2, 1.2, 0.04)); return; }
  try {
    const want = started && !suspended;
    if (want && !windSound) windSound = playClip(wind, { bus: "effects", gain: LEVEL.ambience, loop: true });
    else if (!want && windSound) { windSound.stop(); windSound = null; }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!started || suspended) return;
  const now = context.currentTime;
  if (now >= nextStep) {
    nextStep = Math.max(now, nextStep) + 0.42;
    const h = fnv(seed + "|music|" + musicStep);
    try {
      if (musicStep % 2 === 0) playClip(plucks.get(SCALE[h % SCALE.length]!)!, { bus: "music", gain: LEVEL.music });
      if (musicStep % 8 === 0) playClip(lows.get(SCALE[(h >>> 7) % 4]!)!, { bus: "music", gain: LEVEL.music });
    } catch { /* the mixer is full */ }
    musicStep++;
  }
  if (!nextChirp) nextChirp = now + 2.5;
  if (now >= nextChirp) {
    const h = fnv(seed + "|chirp|" + (chirpCount++));
    const base = 1800 + h % 1200;
    try { playClip(chirp, { bus: "effects", gain: LEVEL.ambience, pitch: base / CHIRP_BASE }); } catch { /* the mixer is full */ }
    nextChirp = now + 3 + (h % 6000) / 1000;
  }
}
