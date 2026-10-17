// Window SHAPE — a design axis independent of the colour theme (theme.ts), so any
// palette can be combined with either corner style. "rounded" is the default;
// "angular" gives sharp (0-radius) corners for the skeleton/brutalist look.
// Applied as <html data-pattern="…">; persisted to localStorage (aidt-window-style).
// Pure + DOM-thin so the value table stays unit-testable (window-style.test.ts).

export type WindowStyle = "rounded" | "angular";

export const WINDOW_STYLES: WindowStyle[] = ["rounded", "angular"];

const KEY = "aidt-window-style";
let current: WindowStyle = load();

function load(): WindowStyle {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "rounded" || v === "angular") return v;
  } catch {
    /* no localStorage (tests/private mode) */
  }
  return "rounded";
}

export function getWindowStyle(): WindowStyle {
  return current;
}

/// Apply a window shape: set <html data-pattern="…"> and persist. The actual
/// corner/outline overrides live in styles.css scoped to that attribute.
export function applyWindowStyle(s: WindowStyle): void {
  current = s === "angular" ? "angular" : "rounded";
  document.documentElement.dataset.pattern = current;
  try {
    localStorage.setItem(KEY, current);
  } catch {
    /* ignore */
  }
}
