// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the meadow texture, tufts, motes, bursts,
// reflections, water, wind, detail) is the browser build's four presets and
// budgets (js/gfx.js TABLE / BUDGETS) keyed by the level's quality tier, with
// the tufts and motes scaled within the tier by the level's particle budget
// against the tier's anchor level (quantum, molecular, terrestrial, galactic),
// at most 2×. The runtime owns the rest of what the old Settings → Graphics
// section did: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout, the GPU summary.
// The old section's per-category overrides are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Scenery and crop shading: Lambert (Low), Standard (Balanced), the authored Standard/Physical (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Procedural meadow texture size in px (the pond's ripple normal map: half). */
  texture: number;
  /** Grass-tuft clumps drawn (Scenery detail on). */
  tufts: number;
  /** Pollen motes at Particles "high". */
  motes: number;
  /** Cap on live harvest/plant burst particles. */
  burst: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Pond rings pulse and the ripple normal map scrolls. */
  waterAnimated: boolean;
  /** Trees and crops sway. */
  wind: boolean;
  particles: "low" | "high";
  /** Meadow texture, tufts, flowers, stones, cottage trim, timber bed frames, rippled pond. */
  detailed: boolean;
  budget: Budget;
}

const ART: Record<QualityTier, Pick<Look, "reflections" | "waterAnimated" | "wind" | "particles" | "detailed">> = {
  low: { reflections: false, waterAnimated: true, wind: true, particles: "low", detailed: false },
  balanced: { reflections: true, waterAnimated: true, wind: true, particles: "low", detailed: true },
  high: { reflections: true, waterAnimated: true, wind: true, particles: "high", detailed: true },
  ultra: { reflections: true, waterAnimated: true, wind: true, particles: "high", detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, tufts: 60, motes: 24, burst: 24 },
  balanced: { material: "standard", texture: 256, tufts: 100, motes: 40, burst: 48 },
  high: { material: "physical", texture: 512, tufts: 140, motes: 70, burst: 80 },
  ultra: { material: "physical", texture: 1024, tufts: 140, motes: 120, burst: 120 },
};
export const TUFT_MAX = 280;
export const MOTE_MAX = 240;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Tufts and motes grow with the level's particle budget above the tier's anchor, at most 2× the tier's
  // budget (gfx.js budgetFor).
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.tufts = Math.min(TUFT_MAX, Math.round(b.tufts * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.texture = Math.min(b.texture, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    // Engine 1.36.1 bug: antialias "off" recolours fog, haze and translucent overlays; the old Low's MSAA
    // stays until engine 1.36.2 (drop this clamp when pinning 1.36.2+).
    antialias: s.antialias === "off" ? "msaa" : s.antialias,
    budget: b,
  };
}
