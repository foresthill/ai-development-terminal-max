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
| `src/app.ts` | Orchestrator: state, lifecycle, navigation, keyboard, settings glue |
| `src/render.ts` | All DOM rendering (strip, grid, depth decks, macro spiral) — stateless, driven by `RenderCtx` |
| `src/persistence.ts` | Workspace snapshot types + localStorage save/load |
| `src/agent.ts` | Agent/Layer model, xterm/browser layer factories, title edit |
| `src/project.ts` | Project model + golden-spiral geometry |
| `src/guard.ts` | Guardrail deny-list **presets** (user policy, not baked-in) |
| `src/ui.ts` | Modal / toast / folder picker / settings dialog |
| `src/pty.ts`, `src/git.ts` | Bridges to Rust commands |
| `src-tauri/src/pty.rs` | portable-pty: spawn/write/resize/kill, default_shell, home_dir |
| `src-tauri/src/git.rs` | is_git_repo, git_clone, create_worktree, write_guardrails |

## File-size rule override

The global rule caps files at 500 lines. **`src/app.ts` may run up to ~650
lines.** It is the single orchestrator; rendering, persistence, guard policy, the
domain models, and all UI have already been extracted. The remaining code is
cohesive lifecycle/state/keyboard wiring whose pieces share too much state to
split further without callback indirection that hurts readability. Prefer
extracting *new* concerns into their own modules over growing app.ts past ~650.

## Conventions

- Verify flag/setting/permission claims against official docs before asserting (user rule). Deny-list syntax + permission modes are sourced from code.claude.com/docs.
- `guard.ts` presets are **opinions**, configurable in Settings — keep the tool neutral so it stays OSS-friendly. Do not hardcode personal policy in Rust.
- `write_guardrails` must never clobber a user-authored `.claude/settings.local.json` (only files tagged `"_aidt": true`), and skips the home dir.
- Worktrees enforce the user's feature-branch / no-main-push workflow physically.

## Status

MVP, partially unverified. Browser layer is iframe (X-Frame-Options sites won't
embed). `auto` permission mode needs account/model support (Opus/Sonnet 4.6+).
