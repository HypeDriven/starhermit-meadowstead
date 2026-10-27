// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the tufts and motes scaled within the tier by the level (frame().levelIndex),
// as the browser build scaled them by its hardware level (at most 2×). The
// runtime owns the rest of what the old Settings → Graphics section did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, the GPU summary. The old
// section's per-category overrides are not offered (the runtime's Options
// choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number; aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, waterAnimated: true, wind: true, particles: "low", detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, waterAnimated: true, wind: true, particles: "low", detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, waterAnimated: true, wind: true, particles: "high", detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, waterAnimated: true, wind: true, particles: "high", detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, tufts: 60, motes: 24, burst: 24, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, tufts: 100, motes: 40, burst: 48, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 512, tufts: 140, motes: 70, burst: 80, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 1024, tufts: 140, motes: 120, burst: 120, bloomRes: 1, aoRes: 1 },
};
export const TUFT_MAX = 280;
export const MOTE_MAX = 240;
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: tufts and motes grow with the level above the tier's first,
  // at most 2× the tier's budget (gfx.js budgetFor).
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.tufts = Math.min(TUFT_MAX, Math.round(b.tufts * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
