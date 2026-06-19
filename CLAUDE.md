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

## Status

MVP, partially unverified. Browser layer is iframe (X-Frame-Options sites won't
embed). `auto` permission mode needs account/model support (Opus/Sonnet 4.6+).
