// Color themes: a small set of built-in palettes. A theme is CSS design tokens
// (applied as custom properties on <html>) plus the xterm terminal colors. The
// choice persists to localStorage (`aidt-theme`) independently of the workspace
// snapshot. Kept data-first so the palette table is unit-testable (theme.test.ts);
// only applyTheme() touches the DOM.

export type ThemeId = "default" | "solarized-dark" | "solarized-light" | "glass";

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export interface Theme {
  id: ThemeId;
  label: string;
  dark: boolean;
  /** CSS custom properties (the `--name` tokens used throughout styles.css). */
  tokens: {
    bg: string;
    panel: string;
    panel2: string;
    border: string;
    accent: string;
    accentDim: string;
    text: string;
    muted: string;
  };
  /** xterm `theme` for the terminal surface. */
  term: TermTheme;
}

// Solarized is Ethan Schoonover's fixed 16-colour palette (2011). Base tones:
//   base03 #002b36  base02 #073642  base01 #586e75  base00 #657b83
//   base0  #839496  base1  #93a1a1  base2  #eee8d5  base3  #fdf6e3
// Accents: blue #268bd2, cyan #2aa198, green #859900, yellow #b58900, etc.
export const THEMES: Record<ThemeId, Theme> = {
  default: {
    id: "default",
    label: "Default (Night)",
    dark: true,
    tokens: {
      bg: "#060810",
      panel: "#0b0e14",
      panel2: "#0e1320",
      border: "#1c2333",
      accent: "#7aa2f7",
      accentDim: "#2d3f76",
      text: "#c8d3f5",
      muted: "#5a6685",
    },
    term: { background: "#0b0e14", foreground: "#c8d3f5", cursor: "#7aa2f7", selectionBackground: "#2d3f76" },
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    dark: true,
    tokens: {
      bg: "#002b36", // base03
      panel: "#073642", // base02
      panel2: "#0a4150",
      border: "#0e4b5a",
      accent: "#268bd2", // blue
      accentDim: "#14415c",
      text: "#93a1a1", // base1
      muted: "#586e75", // base01
    },
    term: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642" },
  },
  "solarized-light": {
    id: "solarized-light",
    label: "Solarized Light",
    dark: false,
    tokens: {
      bg: "#fdf6e3", // base3
      panel: "#eee8d5", // base2
      panel2: "#e4dcc4",
      border: "#d6cdb2",
      accent: "#268bd2", // blue
      accentDim: "#cfe0f0",
      text: "#586e75", // base01 (readable on light)
      muted: "#93a1a1", // base1
    },
    term: { background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", selectionBackground: "#eee8d5" },
  },
  // Cool monochrome "glass" skin. The frosted/translucent deck look is opt-in: it
  // lives in CSS scoped to :root[data-theme="glass"] (styles.css), applied only to
  // the stacked-BEHIND panes — the front pane and the tab strip stay crisp.
  glass: {
    id: "glass",
    label: "Glass (Mono)",
    dark: true,
    tokens: {
      bg: "#0f141a",
      panel: "#161d26",
      panel2: "#1b2531",
      border: "#2a3644",
      accent: "#8fb3cc",
      accentDim: "#223243",
      text: "#c4d2de",
      muted: "#6b7a8a",
    },
    term: { background: "#0f141a", foreground: "#c4d2de", cursor: "#8fb3cc", selectionBackground: "#223243" },
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

const KEY = "aidt-theme";
let current: ThemeId = load();

function load(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v in THEMES) return v as ThemeId;
  } catch {
    /* no localStorage (tests/private mode) — fall through */
  }
  return "default";
}

export function getThemeId(): ThemeId {
  return current;
}

/** The xterm theme for the active palette — used when a terminal is created. */
export function getTermTheme(): TermTheme {
  return THEMES[current].term;
}

/// Apply a theme: set the CSS custom properties on <html data-theme=…>, persist
/// the choice, and return the xterm theme so the caller can update open terminals.
export function applyTheme(id: ThemeId): TermTheme {
  const th = THEMES[id] ?? THEMES.default;
  current = th.id;
  const r = document.documentElement;
  r.dataset.theme = th.id;
  const map: Record<string, string> = {
    "--bg": th.tokens.bg,
    "--panel": th.tokens.panel,
    "--panel-2": th.tokens.panel2,
    "--border": th.tokens.border,
    "--accent": th.tokens.accent,
    "--accent-dim": th.tokens.accentDim,
    "--text": th.tokens.text,
    "--muted": th.tokens.muted,
  };
  for (const [k, v] of Object.entries(map)) r.style.setProperty(k, v);
  try {
    localStorage.setItem(KEY, th.id);
  } catch {
    /* ignore */
  }
  return th.term;
}
