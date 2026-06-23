# AI Dev Terminal MAX — Landing Page Spec

A build-ready brief for an LP (landing page) for **AI Dev Terminal MAX**.
Hand this to whichever agent/dev builds the page. The goal: a single, dark,
fast, honest one-pager that matches the app's look and drives to the GitHub repo
and the `.dmg` download.

- Repo: https://github.com/foresthill/ai-development-terminal-max
- License: MIT · Platform: macOS (Tauri 2 + Rust + xterm.js)
- Status: MVP, actively built. Keep copy credible (no "blazingly fast", no fake metrics).

---

## 1. Positioning

**One-liner:** Run many Claude Code agents in parallel — and see them all at once.

**Sub-line:** A native macOS terminal multiplexer built for AI agents. Each window
is a git **worktree** of your repo, so agents work in parallel without colliding.
A bird's-eye grid, Z-axis depth per window, and a golden-spiral macro view across
projects.

**Who it's for:** developers running Claude Code (and other CLI agents: aider,
codex, gemini) who want to orchestrate several at once and keep an eye on all of
them. People who've hit the wall with tmux/zellij tabs that only show one thing.

**The wedge (vs tmux / zellij):**
1. **Overview** — every agent visible simultaneously in a grid, not hidden in tabs.
2. **Z-axis depth** — each window stacks a terminal + a browser + extra terminals.
3. **Two-level model** — Project (repo) → Agent (worktree) → Layer, so many agents
   touch one repo in parallel, isolated on their own branches.

---

## 2. Key messages (use as feature blocks)

- **See everything at once.** A responsive grid of agent windows; zoom one to
  full width; a macro view spreads all projects on a golden-angle spiral.
- **Worktree isolation, by default.** Each agent runs in its own `git worktree`
  on `feature/yyyymmdd-N`. Parallel work, no stepping on each other; your
  main-branch / PR workflow is enforced physically.
- **Resume where you left off.** Windows relaunch `claude --continue`; close and
  reopen, your conversations come back (per directory). Crash-safe — transcripts
  live on disk.
- **Pick your agent per window.** claude / aider / codex / gemini / custom, from a
  dropdown. Mix them side by side.
- **At-a-glance status.** Per-window CPU + RAM, git branch, and an **amber tint
  when a window is waiting for you**.
- **Yours to control.** Permission mode (auto / normal / bypass), an opt-in
  deny-list guardrail (no push to main, no force-push, …), and a 🪆 nested view
  when a claude spawns subagents.
- **Save slots + auto-restore.** Named workspace snapshots (game-save style) plus
  always-on auto-save/restore.
- **Tiny & native.** Tauri 2 + Rust + the system WebView. ~9 MB app, low RAM —
  not an Electron Chromium bundle. Open source, MIT.

Keep each block to a short headline + 1–2 sentence body. No superlatives.

---

## 3. Design system (match the app exactly)

The app is dark, minimal, "terminal-grade". Reuse these tokens verbatim.

```css
--bg:        #060810;  /* page background (near-black navy) */
--panel:     #0b0e14;  /* cards / surfaces */
--panel-2:   #0e1320;  /* elevated surfaces, toolbar */
--border:    #1c2333;  /* hairline borders */
--accent:    #7aa2f7;  /* primary accent (blue) — links, CTAs, the >_ prompt */
--accent-dim:#2d3f76;  /* accent fills */
--text:      #c8d3f5;  /* primary text (soft lavender-white) */
--muted:     #5a6685;  /* secondary text */
/* status palette (Tokyo Night) */
--amber:     #e0af68;  /* waiting / attention */
--green:     #9ece6a;  /* on / success */
--red:       #f7768e;  /* danger / close */
```

- **Type:** UI = `"SF Pro Text", -apple-system, system-ui, sans-serif`.
  Code / terminal = `Menlo, "SF Mono", monospace`. Use the mono font for any
  command snippets, paths, and the prompt motif.
- **Shape:** rounded rects (8–12px on UI, ~22% on the app tile). Hairline 1px
  borders in `--border`; accent border + soft glow for focus.
- **Icons:** minimal **monochrome line icons** that inherit `currentColor`
  (shield, nested squares, `>_`, globe). No colorful/emoji icons in chrome.
- **Tone of motion:** subtle. Soft glows, gentle transitions (~150–180ms). No
  bouncy animation. One tasteful exception: the macro spiral can rotate/breathe
  slowly in the hero.
- **Background texture:** a faint radial glow (`radial-gradient(circle at 50% 30%,
  #0c1226, var(--bg))`) like the macro view; optional very-low-opacity grid lines.

### App icon / logo
Use `app-icon.svg` (in repo root): dark rounded tile, accent `>_` terminal window,
faint stacked windows behind it (the multiplex / Z-depth idea). The `>_` prompt
and the **stacked-window** motif are the brand shorthand — reuse them in the hero.

---

## 4. Page structure (one-pager, top → bottom)

1. **Nav (sticky, minimal)** — left: icon + "AI Dev Terminal MAX". Right: GitHub
   star, "Download", language toggle (EN/日本語 — the app is bilingual; the LP
   should be too if cheap).
2. **Hero**
   - H1 = the one-liner. Sub = the sub-line. Two CTAs: **Download .dmg** (primary,
     accent) and **View on GitHub** (secondary, outline).
   - Visual: a real screenshot of the **overview grid** (several agent windows),
     OR an animated mock of the **golden-spiral macro view**. Prefer a real
     screenshot for credibility. Dark, glowing, fills the right/below.
   - Small honest badge: "MVP · macOS · MIT".
3. **The problem (1 line) → the model** — a simple diagram:
   `Project (repo) → Agent (worktree) → Layer (terminal / browser)`, plus a note
   that subagents appear nested (🪆). Visual: 3 nested boxes.
4. **Features grid** — 6–8 cards from §2, each with a line icon, headline, 1–2
   lines. 2–3 columns, `--panel` cards, hairline borders.
5. **"Why not just tmux?"** — a short 3-row comparison (Overview of all agents /
   Per-window depth / Worktree-per-agent). Honest, not snarky.
6. **How it works** — 3 steps: ① open a project (folder or clone) ② add agents
   (worktrees) / `fill` ③ `▶` to run, `claude --continue` resumes. Tiny code/kbd
   chips (`Alt+T`, `Alt+Z`, `Alt+M`).
7. **Built on** — Tauri 2 · Rust · xterm.js (WebGL). "~9 MB, native WebView, not
   Electron." Link the stack.
8. **CTA footer** — repeat Download + GitHub. License (MIT), author, a line that
   it's open source and contributions welcome.

Keep it to one scroll-rich page; no signup, no tracking, decline-by-default if any
cookie banner is ever needed (there shouldn't be one).

---

## 5. Assets the builder needs

- `app-icon.svg` (repo root) — logo + favicon source.
- Screenshots (capture from the running app, dark theme):
  - overview grid with several agent windows (hero),
  - the macro golden-spiral view,
  - one zoomed window showing the layer tabs + badges (CPU·RAM, branch).
- The README (`README.md` / `README.ja.md`) is the source of truth for feature
  copy — pull wording from there, don't invent.

If screenshots aren't available yet, the builder may render a faithful **mock**
using the tokens above (dark cards, `>_` prompts, the spiral), clearly as a mock.

---

## 6. Build notes (open to the implementer)

- Any static stack is fine: plain HTML/CSS, Astro, Vite, or Next.js (static
  export). No backend needed. Optimize for fast first paint and tiny JS.
- Ship dark-only (the app is dark-only). Respect `prefers-reduced-motion`.
- Accessibility: real headings, alt text on screenshots, focus styles, AA
  contrast (the palette already passes for text on `--bg`).
- SEO: title "AI Dev Terminal MAX — run many Claude Code agents in parallel",
  meta description from the one-liner, OG image = the hero screenshot.
- Host on GitHub Pages / Vercel / Netlify — implementer's choice.

---

## 7. Copy guidelines

- Honest and concrete. State "MVP", "macOS only", "iframe browser (some sites
  block embedding)" where relevant — credibility sells to this audience.
- No marketing superlatives, no invented numbers. "~9 MB" and "MIT" are real and
  fine to cite.
- Developer voice: short sentences, real keybindings, real commands.
