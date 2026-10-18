# ai-development-terminal-max — project notes for Claude

Native macOS app (Tauri 2 + Rust + xterm.js) to run many Claude Code agents in
parallel and see them all at once.

## Architecture (2-level model)

`Project` (a repo/folder) → `Agent` (a **git worktree** of that repo, isolated
branch `feature/yyyymmdd-N`) → `Layer` (Z-depth: terminal / browser). Multiple
projects run side by side. Views: per-project square grid + a **macro** view that
arranges all projects on a golden-angle (phyllotaxis) spiral.

## Module map (keep responsibilities here)

| File | Responsibility |
|---|---|
| `src/app.ts` | Orchestrator: state, agent/layer lifecycle, navigation, keyboard, settings glue |
| `src/projects-controller.ts` | Project + saved-bookmark lifecycle (open folder/clone, record/open/remove/rename saved) — driven by a `ProjectsCtx` of App accessors |
| `src/render.ts` | All DOM rendering (strip, grid, depth decks, macro spiral) — stateless, driven by `RenderCtx` |
| `src/persistence.ts` | Workspace snapshot types + localStorage save/load + `restoreProjects()` rebuild (App passes a `RestoreBuilder`) |
| `src/agent.ts` | Agent/Layer model, xterm/browser layer factories, title edit |
| `src/project.ts` | Project model + golden-spiral geometry |
| `src/guard.ts` | Guardrail deny-list **presets** (user policy, not baked-in) |
| `src/paths.ts` | Pure clickable-path detection for terminal output (unit-tested) |
| `src/terminal-guards.ts` | Pure CSI guard registration (focus-report + cursor-report-loop break) — reproduced/verified headlessly in `terminal-guards.test.ts` |
| `src/ui.ts` | Modal / toast / folder picker / settings dialog |
| `src/pty.ts`, `src/git.ts` | Bridges to Rust commands |
| `src-tauri/src/pty.rs` | portable-pty: spawn/write/resize/kill, default_shell, home_dir |
| `src-tauri/src/git.rs` | is_git_repo, git_clone, create_worktree, write_guardrails |

## File-size rule override

The global rule caps files at 500 lines. **`src/app.ts` is ~765 lines** (down
from ~840). The queued refactor landed: the project/saved-project lifecycle
(open/clone/saved bookmarks) moved to `projects-controller.ts`, and the
persistence `restore()` rebuild loop moved to `persistence.ts` as
`restoreProjects()`. That removed ~76 net lines — under the documented ~800
budget, but short of the ≤~650 aspiration. **Reaching ≤650 needs one more
extraction**: the agent/layer lifecycle + per-agent CLI-command machinery
(`newAgent` wiring, `addAgentWithCwd`/`addAgentToActive`/`fill`, `setAgentCwd`,
`setAgentCommand`, `primaryLayer`/`shellLayer`/`fillAgentSelect`, layer
add/close) into an `agent-controller.ts` — deferred here to keep this change
behavior-safe and within the named scope. Rendering, persistence I/O, guard
policy, the domain models, and all UI are already extracted; the remainder is
cohesive lifecycle/state/keyboard/settings wiring. **Do not add new features to
app.ts before that follow-up lands** — put new concerns in their own module.

## Design philosophy: cross-agent messaging

- **Manual cross-agent send is supported & recommended.** A human can inject a
  line into another agent's terminal (this / project / all) via the send bar
  (`Alt+Enter`) — the tmux `send-keys` / `synchronize-panes` analog. Low risk
  because a person drives it.
- **Autonomous agent-to-agent command injection is intentionally NOT built.**
  Agents prompting each other across separate claude sessions invites loops,
  token burn, and safety hazards, and loses parent/child context & cancellation.
- **For agent-directed sub-work, the right mechanism is Claude Code's built-in
  subagents (the Task tool)** — shared context, proper control — which this app
  *visualizes* via the 🪆 nest feature. Don't reimplement orchestration by
  injecting commands into other windows.

## Conventions

- Verify flag/setting/permission claims against official docs before asserting (user rule). Deny-list syntax + permission modes are sourced from code.claude.com/docs.
- `guard.ts` presets are **opinions**, configurable in Settings — keep the tool neutral so it stays OSS-friendly. Do not hardcode personal policy in Rust.
- `write_guardrails` must never clobber a user-authored `.claude/settings.local.json` (only files tagged `"_aidt": true`), and skips the home dir.
- Worktrees enforce the user's feature-branch / no-main-push workflow physically.
- **Persistence**: workspace (projects/agents/cwd/layout/toggles) auto-saves to `aidt-workspace`; opened/cloned projects bookmark to `aidt-projects` (label+path). **Resume**: claude agents launch `claude --continue` (resumes the cwd's last conversation, fresh if none) — interactive login shell types the command (so `.zshrc` PATH is correct). Resume facts sourced from code.claude.com/docs/en/sessions.md.

## Known issue: vim (2026-07, REOPENED 2026-10-18) — read before touching the terminal renderer

Full write-up: `docs/2026-07-15-vim-debugging-journey.md`.

- **Input side: SOLVED.** vim died seconds after opening because the PTY reader
  treated *any* read error as exit → `pty-exit` → layer close → SIGHUP → vim
  died with the shell. macOS returns transient read errors while the child is
  alive; vim's startup terminal queries trigger them, **nano's don't** — that
  asymmetry is what made this look like an alt-screen/xterm bug for ~30 build
  cycles. Fixed in `pty.rs` with a `libc::kill(pid, 0)` liveness check.
- **Display side: NOT solved in a release build (2026-10-18).** The alt-screen is
  a **WKWebView compositing bug**: xterm writes the rows into the DOM but WKWebView
  does not re-rasterize them, so the screen stays blank. `Alt+Shift+D` proves it —
  `buf alternate nonEmpty=21/27 | DOM rows=27 nonEmpty=21` with a black screen = DOM
  populated, not composited (not a buffer or renderer fault). Removing the vestigial
  3D context (`perspective`/`preserve-3d`) from `.stack` **is in the shipped bundle**
  (verified in `dist` CSS) but did **not** fix it on its own.
  - **Confirmed facts:** (a) the CSS fix is in the shipped bundle; (b) a release
    `.app` shows DOM-populated-but-blank; (c) `tauri dev` renders vim fine. So the
    dev/release behaviour genuinely differs — the 2026-10-16 "on-device confirmed"
    was a **dev build**, so it did not actually prove the release case.
  - **Leading hypothesis (NOT yet proven — we don't fully understand it yet):**
    `tauri = { features = [] }` (no `devtools`), so the WKWebView Web Inspector is on
    in `tauri dev` (debug) and off in release; an attached inspector *may* keep forcing
    layer re-rasterization and thereby hide the bug. Plausible but unverified — treat
    the real cause as still OPEN, not settled.
  - **⚠️ PROCESS RULE: validate any terminal-rendering change in a RELEASE build
    (`pnpm tauri build` → open the .app), NEVER only in `tauri dev`.** This reverses
    the earlier advice to lean on `tauri dev`/DevTools — for *compositing* bugs DevTools
    lies to you. (HMR/DevTools is still fine for logic, layout, and theming work.)
- **Input side: still SOLVED** independent of the above — the cursor-report loop
  (`\e[?6n` → xterm auto-replies `\e[?25;4R` → written back to the PTY → repeat) that
  buried keystrokes is swallowed in `terminal-guards.ts`. Keep it.
- **Next, to actually fix the compositing bug (must be release-validated):** force
  WKWebView to re-rasterize the front terminal (replicate what the inspector does).
  Candidates, cheapest first: (1) `will-change` / de-promote the front `.layer` so its
  text isn't cached in a stale composited layer; (2) a per-`onRender` raster-invalidation
  nudge on `.xterm-screen` (a *2D* transform/opacity/filter toggle — **never** `translateZ`
  or any 3D, that reintroduces the original context); (3) last resort, native rendering.
- **Dead ends** (keep for safety): `window.IntersectionObserver = undefined` throws
  inside `open()` → blanks **every** terminal (`DOM rows=0`); if render-pause ever needs
  disabling use `delete` on the key, not `= undefined`. `set t_ti= t_te=` only moves vim
  to the normal buffer, it doesn't repaint updates. **CAVEAT:** every other display-side
  "dead end" once listed here (refit-on-toggle, DECSET 1004, disabling WebGL, forced
  `refresh()`, `options.theme` re-assign, xterm 5.5 downgrade, `@xterm/addon-canvas`) was
  judged in a **dev build under DevTools masking**, so those verdicts are **unreliable
  for the compositing bug** — re-test in a release build before trusting them.
- Workaround (no longer required): `set t_ti= t_te=` renders vim in the normal buffer;
  nano also works.
- **Debug tracers** live behind `Alt+D` (off by default — when off they don't run
  at all, including the per-output-byte tracer).

## Status

MVP, partially unverified. Browser layer is iframe (X-Frame-Options sites won't
embed). `auto` permission mode needs account/model support (Opus/Sonnet 4.6+).
