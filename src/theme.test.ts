import { describe, it, expect } from "vitest";
import { THEMES, THEME_IDS, getThemeId, getTermTheme } from "./theme";

// Data integrity for the palette table. applyTheme() touches the DOM so it's not
// exercised here (node env) — this guards the pure color data every theme must
// provide, so a new theme can't ship missing tokens.

const TOKEN_KEYS = ["bg", "panel", "panel2", "border", "accent", "accentDim", "text", "muted"] as const;
const TERM_KEYS = ["background", "foreground", "cursor", "selectionBackground"] as const;
const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

describe("themes", () => {
  it("includes the built-in palettes", () => {
    expect(THEME_IDS).toContain("default");
    expect(THEME_IDS).toContain("solarized-dark");
    expect(THEME_IDS).toContain("solarized-light");
  });

  it("every theme defines all CSS tokens as valid 6-digit hex", () => {
    for (const id of THEME_IDS) {
      const th = THEMES[id];
      for (const k of TOKEN_KEYS) {
        expect(isHex(th.tokens[k]), `${id}.tokens.${k} = ${th.tokens[k]}`).toBe(true);
      }
    }
  });

  it("every theme defines all xterm colors as valid 6-digit hex", () => {
    for (const id of THEME_IDS) {
      const term = THEMES[id].term;
      for (const k of TERM_KEYS) {
        expect(isHex(term[k]), `${id}.term.${k} = ${term[k]}`).toBe(true);
      }
    }
  });

  it("the id field matches its key and label is non-empty", () => {
    for (const id of THEME_IDS) {
      expect(THEMES[id].id).toBe(id);
      expect(THEMES[id].label.length).toBeGreaterThan(0);
    }
  });

  it("uses the canonical Solarized base backgrounds", () => {
    expect(THEMES["solarized-dark"].term.background).toBe("#002b36"); // base03
    expect(THEMES["solarized-light"].term.background).toBe("#fdf6e3"); // base3
  });

  it("defaults to the night theme with no stored choice (node: no localStorage)", () => {
    expect(getThemeId()).toBe("default");
    expect(getTermTheme()).toEqual(THEMES.default.term);
  });
});
