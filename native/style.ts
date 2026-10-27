// The look of the menus, HUD, rails and dialogs: the browser build's style.css,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects, text
// fields, scroll bars) take, in the system sans. The browser build's
// body.high-contrast palette is a token set here, applied while the runtime's
// high-contrast option is on (the title key art is dropped then, as before).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** style.css body.high-contrast: near-black page and panels, white ink, a light green accent. */
const HIGH_CONTRAST: Tokens = {
  bg: "#101010", panel: "#1c1c1c", ink: "#f5f5f5", soft: "#dddddd", chip: "#333333", "chip-hover": "#444444",
  accent: "#7fd77f", line: "#ffffff44", scrim: "#101010e0",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "system-ui" });
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 32, padding: 8, spacing: 8, radius: 10,
    text: "#24301e", muted: "#5b6455", panel: "#ffffff", control: "#dde8d2", hovered: "#d2ddc7",
    pressed: "#c6d3ba", field: "#ffffff", accent: "#3f7d3f", focus: "#1a5fd7", outline: "#00000033",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$panel", border: { width: 2, color: "$soft" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { background: "$panel", border: { width: 1, color: "$soft" }, radius: 8, text: { color: "$ink" }, minHeight: 40 },
    textField: { background: "$panel", border: { width: 1, color: "$soft" }, radius: 8, text: { color: "$ink" }, minHeight: 44 },
    progress: { parts: { track: { background: "#24301e1a", radius: 6 }, fill: { background: "$accent", radius: 6 } } },
    scrollArea: { parts: { bar: { background: "#24301e55", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
  });
}

let key = "";
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyPalette(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  ui.setTokens({ ...base, ...(highContrast ? HIGH_CONTRAST : {}) });
}
