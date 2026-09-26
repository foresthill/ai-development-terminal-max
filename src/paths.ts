// Pure file-path detection for terminal output — extracted from agent.ts so it
// can be unit-tested without xterm/Tauri. Given a line of text (a wrapped logical
// line already joined by the caller), returns the character spans that should
// become clickable path links, de-duplicated so no span overlaps a URL or an
// already-claimed span.
//
// Three families of match, in priority order:
//   1. whole-line — the entire trimmed line is an absolute/home path. The only
//      way to catch a path containing SPACES (very common on macOS, e.g.
//      `~/Obsidian Vault/…`), since a space bounds a token.
//   2. quoted — a rooted path inside "…" '…' `…` (spaces allowed, unambiguous).
//   3. inline — slash tokens with no spaces: rooted files/dirs, relative files
//      (`docs/x/foo.md`), relative dirs (`src/components/`). A leading look-behind
//      stops a mid-word slash (`read/write`, `and/or`, `TCP/IP`) reading as `/write`.
// URLs are reserved first so a path matcher never re-claims a slice inside one
// (the `com/a.md` of `x.com/a.md`) — that would fire two open handlers at once.

const SEG = "[\\p{L}\\p{N}._\\-@+]+";

/** Inline slash tokens (no spaces). Global + unicode. */
export const PATH_RE = new RegExp(
  "(?<![\\p{L}\\p{N}._\\-@+/~])(?:" +
    `(?:~\\/|\\.{1,2}\\/|\\/)${SEG}(?:\\/${SEG})*\\/?` + // rooted: file or directory
    `|${SEG}(?:\\/${SEG})+\\.[A-Za-z0-9]{1,8}` + // relative file  seg/seg.ext
    `|${SEG}(?:\\/${SEG})+\\/` + // relative directory  seg/seg/
    ")(?::\\d+(?:[:.]\\d+)?)?",
  "gu",
);

/** The whole trimmed line is an absolute/home path (allows spaces). Punctuation
 *  that never appears in paths (`,` `!` `?` …) is excluded so prose starting with
 *  `/` doesn't match. */
export const FULL_PATH_RE = /^(?:~\/|\/)[\p{L}\p{N}\p{M} ._\-@+()&'’/]+?(?::\d+(?:[:.]\d+)?)?$/u;

/** A quoted rooted path — `"/Users/foo bar/x"` — unambiguous even with spaces. */
export const QUOTE_RE = /["'`]((?:~\/|\.{1,2}\/|\/)[^"'`\n]{1,512}?)["'`]/gu;

const URL_RE = /https?:\/\/\S+/gu;

export interface PathSpan {
  /** inclusive start index into the input text */
  start: number;
  /** exclusive end index */
  end: number;
  /** the matched path text (what gets resolved + opened) */
  raw: string;
}

/// Find the clickable path spans in `text`. Spans never overlap each other or a
/// URL. Order: whole-line, then quoted, then inline (matches the original
/// link-provider order; callers map each span to a terminal cell range).
export function findPathSpans(text: string): PathSpan[] {
  const reserved: Array<[number, number]> = [];
  const out: PathSpan[] = [];
  const overlaps = (s: number, e: number) => reserved.some(([rs, re]) => s < re && e > rs);
  const add = (start: number, end: number, raw: string) => {
    out.push({ start, end, raw });
    reserved.push([start, end]);
  };

  // 1) Reserve URL spans (owned by the web-links handler) — don't emit them.
  URL_RE.lastIndex = 0;
  let um: RegExpExecArray | null;
  while ((um = URL_RE.exec(text)) !== null) reserved.push([um.index, um.index + um[0].length]);

  // 2) Whole-line absolute/home path.
  const lead = text.length - text.trimStart().length;
  const body = text.trim();
  if (body && FULL_PATH_RE.test(body) && !overlaps(lead, lead + body.length))
    add(lead, lead + body.length, body);

  // 3) Quoted rooted paths — the inner text, not the quotes.
  QUOTE_RE.lastIndex = 0;
  let qm: RegExpExecArray | null;
  while ((qm = QUOTE_RE.exec(text)) !== null) {
    const start = qm.index + 1; // skip the opening quote
    const inner = qm[1];
    if (!overlaps(start, start + inner.length)) add(start, start + inner.length, inner);
  }

  // 4) Inline tokens.
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!overlaps(start, end)) add(start, end, m[0]);
  }

  return out;
}
