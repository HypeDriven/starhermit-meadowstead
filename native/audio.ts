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
// gain. The plucks, the wind and the chirp are rendered offline into clips once
// at start (OfflineAudioContext). The synthesized stand-ins the browser build played while a
// sample decoded are not ported, so a sample still loading is silent (its
// caption still shows). Every sample loads at once in onStart (the engine hands
// each loaded clip to the mixer, natively and in a browser); the music and ambience wait for the mixer to run (in a
// browser, the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

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

/** Loads every sample and renders the synthesized clips at once (onStart); a cue whose sample is still loading is silent. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SFX).flat())) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  renderClips();
}

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
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered clips -------------------------------------------------------------------
const RATE = 22050;
/** audio.js tone(bus, f, dur, 'sine', gain[, slideTo]): gain then an exponential ramp to 0.0001 over dur. */
async function toneClip(freq: number, dur: number, gain: number, slideTo?: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((dur + 0.02) * RATE), RATE);
  const osc = off.createOscillator();
  osc.frequency.setValueAtTime(freq, 0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, dur);
  const g = off.createGain();
  g.gain.setValueAtTime(gain, 0);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  osc.connect(g).connect(off.destination);
  osc.start();
  return createClip(await off.startRendering());
}
/** audio.js startAmbience: two seconds of noise, darkened (the old leaky integrator, about 71 Hz), through a 400 Hz
 * low-pass, looped; periodic once the filters settle. WIND_GAIN: the old stem's level, measured. */
const WIND_GAIN = 1.64;
async function windClip(): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: fnv("meadow-wind"), seconds: 2 });
  const dark = off.createBiquadFilter();
  dark.type = "lowpass";
  dark.frequency.value = 71;
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  const g = off.createGain();
  g.gain.value = WIND_GAIN;
  noise.connect(dark).connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
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

/** Renders the plucks, the wind and the chirp, one context a clip (14, under the 16 at once). */
function renderClips(): void {
  const warn = (e: unknown): void => console.warn(`audio: ${String(e)}`);
  windClip().then((c) => { wind = c; }, warn);
  toneClip(CHIRP_BASE, 0.09, 0.05, CHIRP_BASE * 1.3).then((c) => { chirp = c; }, warn);
  for (const f of SCALE) toneClip(f, 0.5, 0.05).then((c) => { plucks.set(f, c); }, warn);
  for (const f of SCALE.slice(0, 4)) toneClip(f / 2, 1.2, 0.04).then((c) => { lows.set(f, c); }, warn);
}

/** audio.js resume(): ambience and music run from the first press on (and from boot natively). */
export function start(): void { started = true; }
/** A hidden window: the music and ambience hold (audio.js stopped its timers). */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame once the mixer runs and the clips are rendered: the wind by state and the music's and
 * chirps' next steps by mixer time. */
export function update(): void {
  if (context.state !== "running" || !wind || !chirp || plucks.size < SCALE.length || lows.size < 4) return;
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
