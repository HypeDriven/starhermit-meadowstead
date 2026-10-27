// Localization: the browser build's tables (js/strings.js + js/i18n.js,
// English source strings as the keys; js/sh-strings.js for the StarHermit
// account lines) in the nine StarHermit locales, in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's own Language setting (sh-language.js)
// and the DOM re-labelling of the old i18n.js: every string is drawn through
// T() each frame, so a change shows on the next frame.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n } from "./classic.ts";
import { SH_STRINGS } from "../js/sh-strings.js";

export interface AccountStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string; playingAs: string;
  lbPosting: string; lbRank: string; lbPosted: string; lbNotPosted: string;
}
const SH = SH_STRINGS as unknown as Record<string, AccountStrings>;
export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The tables' rich text (<b>…</b>) as plain text. */
export const plain = (s: string): string => s.replace(/<\/?b>/g, "");
let locale = "en-US";
/** The account strings (sign-in, invite, toasts, leaderboard line) in the game language. */
export function account(): AccountStrings { return SH[locale] ?? SH["en-US"]!; }
export function currentLocale(): string { return locale; }

function apply(tag: string): void {
  locale = I18n.setLocale(I18n.pickLocale(tag));
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => { if (I18n.pickLocale(p.language) !== locale) apply(p.language); });
