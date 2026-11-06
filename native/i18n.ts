// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: English source strings as the keys, the nine
// StarHermit locales) and its `starhermit.*` account lines, in the interface
// language the runtime reports (the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replaced the game's own Language setting (sh-language.js) and the DOM
// re-labelling of the old i18n.js: every string is drawn through T() each frame,
// so a change shows on the next frame.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. Anything without a message passes through. */
export function T(key: string, vars?: Vars | null): string {
  if (strings.has(key)) return strings.t(key, vars ?? undefined);
  return vars ? key.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : key;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The tables' rich text (<b>…</b>) as plain text. */
export const plain = (s: string): string => s.replace(/<\/?b>/g, "");
/** The engine's account lines (sign-in, invite, toasts, leaderboard line). */
export function account(name: string, vars?: Vars): string { return strings.t(`starhermit.${name}`, vars); }
