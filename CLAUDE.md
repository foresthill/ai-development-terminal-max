# ai-development-terminal-max — project notes for Claude

Native cross-platform desktop app (macOS / Windows / Linux — Tauri 2 + Rust +
xterm.js) to run many Claude Code agents in parallel and see them all at once.
macOS is the primary dev/target (the full-screen-TUI display notes below are
macOS-specific); Windows and Linux builds ship in every release.

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

## vim / full-screen TUIs — read before touching the terminal renderer

**Status (2026-10-25): input SOLVED; display UNFIXABLE in-webview on macOS 26.**
Full-screen TUIs (vim/less/htop) don't display on **macOS 26 (Tahoe) release builds**
— a WKWebView compositor bug ([wry#1848](https://github.com/tauri-apps/wry/issues/1848))
that is **not our code**. They work on Windows, Linux and older macOS. The planned way to
edit on macOS 26 is a **DOM-based editor layer** (normal HTML repaints fine), not the
terminal. Do NOT spend more cycles on webview/CSS/renderer tricks for this — they are all
exhausted (see the dead-ends and the journey doc).

Full write-up: `docs/2026-07-15-vim-debugging-journey.md`.

- **Input side: SOLVED.** vim died seconds after opening because the PTY reader
  treated *any* read error as exit → `pty-exit` → layer close → SIGHUP → vim
  died with the shell. macOS returns transient read errors while the child is
  alive; vim's startup terminal queries trigger them, **nano's don't** — that
  asymmetry is what made this look like an alt-screen/xterm bug for ~30 build
  cycles. Fixed in `pty.rs` with a `libc::kill(pid, 0)` liveness check.
- **Display side: macOS 26 WKWebView compositor bug — [wry#1848](https://github.com/tauri-apps/wry/issues/1848), NOT our code.**
  On an Apple-Silicon RELEASE build the compositor stops presenting new frames for any
  full-screen in-place redraw while the DOM keeps updating. Proof: `Alt+Shift+D` showed
  `DOM rows=27 nonEmpty=27` with row 0 = `HELLO` while the screen still showed the empty
  first frame, and `cat test.txt` = `HELLO` — input, xterm, the DOM and the file were all
  correct; only the painted pixels were stale. It reproduces with the DOM renderer AND
  WebGL, with a single layer, and survives a window resize. Our versions (wry 0.55.1 /
  tauri 2.11.2) match the report. Full write-up:
  `docs/2026-10-24-macos26-wkwebview-altscreen.md`.
  - **The alt-screen workaround did NOT fix it (disabled 2026-10-25).** We tried swallowing
    the alt-screen switch (DECSET 47/1047/1049) so TUIs render on the normal buffer. On
    device, the dump then showed `type=normal` with the DOM fully populated — **and the
    screen was STILL frozen.** The macOS 26 compositor fails to present full-screen in-place
    redraws on **either** buffer; the alt-screen was never the discriminator. So
    `sys::alt_screen_broken` now returns `false` (no-op); the swallow code stays only for
    history. The one update that DID present was single-line scroll/append (`printf
    '\rcount'`) and shell output — i.e. only the moving/appended region repaints.
  - **The real plan: a DOM-based editor layer.** A normal-HTML editor (textarea/CodeMirror)
    repaints fine on macOS 26 (it's not a terminal), so that's how editing works there.
    vim-in-terminal stays the path on Windows/Linux/older macOS.
  - **⚠️ PROCESS RULE: validate terminal-rendering changes in a RELEASE build
    (`pnpm tauri build`), NEVER only `tauri dev`** — dev never showed this bug (the
    regression is release-only), which cost many cycles. HMR/DevTools stays fine for
    logic/layout/theming.
- **Dead ends — do NOT retry on this bug** (all confirmed useless for the macOS 26
  compositor freeze, in a real release): removing `.stack`'s 3D context; de-promoting
  `.layer` (drop transition/clip); per-render repaint nudges on `.xterm-screen`/`.layer`
  (opacity/transform/filter/`display`-reflow); a window resize; enabling the `devtools`
  feature; switching DOM↔WebGL; **swallowing the alt-screen (TUIs on the normal buffer
  freeze the same way)**. Still true generally: `window.IntersectionObserver = undefined`
  throws inside `open()` → blanks every terminal (use `delete`, not `= undefined`). The
  only real fixes left: a newer wry/WebKit with the bug fixed, or native rendering — but
  for *editing* specifically, the DOM editor layer sidesteps all of it.
- **Debug tracers** live behind `Alt+D` (off by default — when off they don't run
  at all, including the per-output-byte tracer).

## Status

MVP, partially unverified. Browser layer is iframe (X-Frame-Options sites won't
embed). `auto` permission mode needs account/model support (Opus/Sonnet 4.6+).
