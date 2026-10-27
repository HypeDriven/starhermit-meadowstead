// The browser build's pure scripts, shared with the Node tests and the dev
// server.js: the deterministic rules (js/rules.js, UMD) and the string tables
// with their lookup (js/strings.js, js/i18n.js), evaluated as classic scripts so
// their globals are this module's exports.
import { loadClassic } from "starhermit:script";

for (const f of ["js/rules.js", "js/strings.js", "js/i18n.js"]) loadClassic(f);

export type Crop = "turnip" | "carrot" | "pumpkin";
export type Season = "spring" | "summer" | "autumn";
export interface CropState { type: Crop; age: number; watered: boolean; thirsty: number; ready: boolean }
export interface Order { id: string; needs: Record<string, number>; reward: number; score: number }
export interface Score { orders: number; harvests: number; crafting: number; coins: number; variety: number; timeBonus: number; total: number }
export interface Config {
  mode: string; seed: string; maxTicks: number; goalOrders: number; plotCount: number;
  allowedCrops: string[]; allowedRecipes: string[]; difficulty: string;
  assists: { hints: boolean; undo: boolean }; contentVersion: number; stage?: number; mastery?: boolean;
}
export interface State {
  schema: number; contentVersion: number; mode: string; seed: string; difficulty: string; tick: number; maxTicks: number;
  goalOrders: number; plotCount: number; allowedCrops: string[]; allowedRecipes: string[]; assists: { hints: boolean; undo: boolean };
  plots: { crop: CropState | null }[]; inventory: Record<string, number>; coins: number; orders: Order[];
  nextOrderSerial: number; ordersFulfilled: number; orderScore: number; harvestCount: number; craftCount: number;
  variety: Record<string, boolean>; invalidActions: number; rngCalls: { orders: number }; appliedIds: string[];
  terminalReason: string | null; score: Score | null;
}
export interface Command { id?: string; type: string; plot?: number; crop?: string; recipe?: string; orderId?: string }
export interface Event { type: string; plot?: number; crop?: string; recipe?: string; orderId?: string; reward?: number; reason?: string; score?: Score }
export interface Legal { type: string; plot?: number; crop?: string; recipe?: string; orderId?: string }

export interface RulesApi {
  SCHEMA_VERSION: number; CONTENT_VERSION: number; SEASON_TICKS: number; WITHER_TICKS: number;
  CROPS: Record<string, { name: string; grow: number; value: number; seasons: Season[] }>;
  RECIPES: Record<string, { name: string; needs: Record<string, number>; value: number }>;
  seasonAt(tick: number): Season;
  defaultConfig(mode: string, seed: string, overrides?: Partial<Config>): Config;
  createSession(config: Config): State;
  check(state: State, cmd: Command): { ok: boolean; reason: string | null };
  legalActions(state: State): Legal[];
  apply(state: State, cmd: Command): { state: State; ok: boolean; reason: string | null; events: Event[] };
  computeScore(state: State): Score;
  stateHash(state: State): string;
  serialize(state: State): string;
  deserialize(json: string): State;
  dailySeed(date: string): string;
  journeyStage(n: number): Config;
}
export interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  pickLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
const g = globalThis as unknown as { MeadowRules: RulesApi; MSI18N: I18nApi };
export const Rules = g.MeadowRules;
export const I18n = g.MSI18N;
