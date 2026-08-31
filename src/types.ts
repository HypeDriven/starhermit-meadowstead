export type GameMode = 'learn' | 'journey' | 'daily' | 'practice' | 'challenge';

export interface Vec3 { x: number; y: number; z: number }

export const SCHEMA_VERSION = 1;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}
