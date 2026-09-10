/* Meadowstead — WebAudio: buses, SFX, ambience, adaptive music.
   One-shot SFX prefer authored samples (sfx/*.opus, lazy-loaded after unlock)
   with original procedural synthesis as fallback; music/ambience stay procedural.
   Synthesized variants are seeded for replay consistency. */
(function (root) {
'use strict';

const A = {
  ctx: null,
  buses: {},
  enabled: { music: true, effects: true, ambience: true, voice: true },
  volumes: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.8 },
  muted: false,
  seed: 'audio',
  variantCalls: 0,
  musicTimer: null,
  ambNodes: [],
  captions: [],
  onCaption: null,
};

function ensureCtx() {
  if (A.ctx) return true;
  const Ctor = root.AudioContext || root.webkitAudioContext;
  if (!Ctor) return false;
  A.ctx = new Ctor();
  const master = A.ctx.createGain();
  master.gain.value = 1;
  master.connect(A.ctx.destination);
  A.master = master;
  for (const name of ['music', 'effects', 'ambience', 'voice']) {
    const g = A.ctx.createGain();
    g.gain.value = A.volumes[name];
    g.connect(master);
    A.buses[name] = g;
  }
  return true;
}

function resume() {
  if (!ensureCtx()) return;
  if (A.ctx.state === 'suspended') A.ctx.resume();
  startAmbience();
  startMusic();
}

function setVolume(bus, v) {
  A.volumes[bus] = v;
  if (A.buses[bus]) A.buses[bus].gain.value = A.muted ? 0 : v;
}
function setMuted(m) {
  A.muted = m;
  for (const b of Object.keys(A.buses)) A.buses[b].gain.value = m ? 0 : A.volumes[b];
}

function caption(text) {
  if (A.onCaption) A.onCaption(text);
}

function variant() {
  // seeded pitch variant so replays sound identical
  let h = 2166136261 >>> 0;
  const s = A.seed + '|' + (A.variantCalls++);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 0.9 + (h >>> 0) % 1000 / 5000; // 0.9 .. 1.1
}

function tone(bus, freq, dur, type, gain, slideTo) {
  if (!A.ctx || A.muted) return;
  const t = A.ctx.currentTime;
  const o = A.ctx.createOscillator();
  const g = A.ctx.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain || 0.2, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(A.buses[bus]);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(bus, dur, gain, filterFreq) {
  if (!A.ctx || A.muted) return;
  const t = A.ctx.currentTime;
  const len = Math.max(1, Math.floor(A.ctx.sampleRate * dur));
  const buf = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = A.ctx.createBufferSource();
  src.buffer = buf;
  const f = A.ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
  const g = A.ctx.createGain();
  g.gain.value = gain || 0.15;
  src.connect(f); f.connect(g); g.connect(A.buses[bus]);
  src.start(t);
}

/* Authored sample one-shots (sfx/<name>.opus, see sfx/manifest.json).
   Lazy-fetched and decoded only after the user-gesture unlock (resume()).
   Each event prefers its mapped sample; synthesized fallbacks below run
   while the sample is still loading or if fetching/decoding fails. */
const SAMPLE_MAP = {
  click:    ['ui-click'],
  plant:    ['plant-seed'],
  water:    ['water-pour'],
  harvest:  ['harvest-pick', 'harvest-basket'],
  craft:    ['craft-tap'],
  fulfill:  ['order-fulfill'],
  grown:    ['crop-grown'],
  wither:   ['crop-wither'],
  invalid:  ['action-denied'],
  pause:    ['pause-menu'],
  terminal: ['session-complete'],
  season:   ['season-turn'],
  undo:     ['undo-rewind'],
  achievement: ['achievement-unlock'],
};
const sampleCache = {}; // name -> AudioBuffer | 'loading' | null (failed)

function fetchSample(name) {
  if (sampleCache[name] !== undefined || !A.ctx) return;
  sampleCache[name] = 'loading';
  fetch('sfx/' + name + '.opus')
    .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
    .then((ab) => A.ctx.decodeAudioData(ab))
    .then((buf) => { sampleCache[name] = buf; })
    .catch(() => { sampleCache[name] = null; }); // permanent synth fallback
}

function trySample(evt) {
  if (!A.ctx || A.muted) return false;
  const names = SAMPLE_MAP[evt];
  if (!names) return false;
  const name = names[Math.floor(variant() * 1000) % names.length];
  const cached = sampleCache[name];
  if (cached instanceof AudioBuffer) {
    const src = A.ctx.createBufferSource();
    src.buffer = cached;
    src.connect(A.buses.effects);
    src.start();
    return true;
  }
  fetchSample(name);
  return false;
}

const SYNTH = {
  click:    () => { tone('effects', 660 * variant(), 0.06, 'triangle', 0.12); },
  plant:    () => { noise('effects', 0.12, 0.12, 500); tone('effects', 220 * variant(), 0.1, 'sine', 0.12); },
  water:    () => { noise('effects', 0.25, 0.15, 2400); tone('effects', 880 * variant(), 0.15, 'sine', 0.06, 440); },
  harvest:  () => { tone('effects', 520 * variant(), 0.09, 'triangle', 0.16); tone('effects', 780 * variant(), 0.12, 'triangle', 0.12); },
  craft:    () => { tone('effects', 330, 0.1, 'square', 0.07); tone('effects', 495 * variant(), 0.14, 'triangle', 0.12); },
  fulfill:  () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone('effects', f * variant(), 0.16, 'triangle', 0.14), i * 90)); },
  grown:    () => { tone('effects', 990 * variant(), 0.1, 'sine', 0.08, 1320); },
  wither:   () => { tone('effects', 300, 0.3, 'sawtooth', 0.06, 140); },
  invalid:  () => { tone('effects', 180, 0.12, 'square', 0.08); },
  pause:    () => { tone('effects', 440, 0.08, 'sine', 0.1); },
  terminal: () => { [392, 523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone('effects', f, 0.25, 'triangle', 0.13), i * 130)); },
  season:   () => { noise('effects', 0.6, 0.05, 900); [587, 784, 880].forEach((f, i) => setTimeout(() => tone('effects', f, 0.5, 'sine', 0.07), i * 160)); },
  undo:     () => { tone('effects', 300, 0.18, 'sine', 0.09, 620); noise('effects', 0.14, 0.05, 3000); },
  achievement: () => { [659, 880, 1175].forEach((f, i) => setTimeout(() => tone('effects', f, 0.3, 'triangle', 0.12), i * 110)); },
};

const SFX = {};
{
  const caps = {
    click: 'click', plant: 'planting', water: 'watering', harvest: 'harvest',
    craft: 'crafting', fulfill: 'order fulfilled', grown: 'a crop is ready',
    wither: 'a crop withered', invalid: 'action not allowed', terminal: 'session complete',
    season: 'the season turns', undo: 'action undone', achievement: 'achievement unlocked',
  };
  for (const evt of Object.keys(SYNTH)) {
    SFX[evt] = () => {
      if (caps[evt]) caption(caps[evt]);
      if (!trySample(evt)) SYNTH[evt]();
    };
  }
}

/* Ambience: gentle filtered noise wind + occasional seeded bird chirps. */
function startAmbience() {
  if (!A.ctx || A.ambNodes.length) return;
  const len = A.ctx.sampleRate * 2;
  const buf = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
  const d = buf.getChannelData(0);
  let v = 0;
  for (let i = 0; i < len; i++) { v = v * 0.98 + (Math.random() * 2 - 1) * 0.02; d[i] = v * 4; }
  const src = A.ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const f = A.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
  const g = A.ctx.createGain(); g.gain.value = 0.5;
  src.connect(f); f.connect(g); g.connect(A.buses.ambience);
  src.start();
  A.ambNodes.push(src);
  let chirpCount = 0;
  const chirp = () => {
    if (!A.ctx) return;
    if (document.hidden) { setTimeout(chirp, 4000); return; }
    let h = 2166136261 >>> 0;
    const s = A.seed + '|chirp|' + (chirpCount++);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const base = 1800 + (h >>> 0) % 1200;
    tone('ambience', base, 0.09, 'sine', 0.05, base * 1.3);
    setTimeout(chirp, 3000 + (h >>> 0) % 6000);
  };
  setTimeout(chirp, 2500);
}

/* Music: soft pentatonic plucks, adaptive tempo by game phase. */
const SCALE = [262, 294, 330, 392, 440, 523, 587, 659];
let musicStep = 0;
function startMusic() {
  if (!A.ctx || A.musicTimer) return;
  const step = () => {
    if (!A.ctx) return;
    if (!document.hidden) {
      let h = 2166136261 >>> 0;
      const s = A.seed + '|music|' + (musicStep);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      if (musicStep % 2 === 0) {
        tone('music', SCALE[(h >>> 0) % SCALE.length], 0.5, 'sine', 0.05);
      }
      if (musicStep % 8 === 0) {
        tone('music', SCALE[(h >>> 7) % 4] / 2, 1.2, 'sine', 0.04);
      }
      musicStep++;
    }
    A.musicTimer = setTimeout(step, document.hidden ? 2000 : 420);
  };
  step();
}
function stopAll() {
  if (A.musicTimer) { clearTimeout(A.musicTimer); A.musicTimer = null; }
}

root.MeadowAudio = {
  resume, setVolume, setMuted, sfx: SFX, stop: stopAll,
  isStarted: () => !!A.ctx,
  setSeed: (s) => { A.seed = String(s); },
  setCaptionHandler: (fn) => { A.onCaption = fn; },
  get volumes() { return A.volumes; },
};
})(typeof self !== 'undefined' ? self : globalThis);
