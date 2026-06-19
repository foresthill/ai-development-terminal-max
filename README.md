# AI Dev Terminal MAX

English ・ [日本語](./README.ja.md)

A native macOS terminal multiplexer for running many [Claude Code](https://docs.claude.com/en/docs/claude-code) agents **in parallel** and seeing **all of them at once**. Unlike tmux/zellij:

1. **Overview grid** — every agent is visible at the same time, not hidden behind tabs.
2. **Z-axis depth** — each agent owns a vertical stack of layers (the claude terminal, a browser, an extra terminal) shown as a deck.
3. **Two-level model** — `Project` (a repo) → `Agent` (a **git worktree** on an isolated branch) → `Layer`, so many agents work the same repo in parallel without colliding.

> ⚠️ Status: **MVP, partially unverified.** The browser layer is iframe-based, so sites that send `X-Frame-Options` won't embed (known limitation).

## Stack

| Layer | Tech | Role |
|---|---|---|
| Backend | Rust + [Tauri 2](https://tauri.app) | window, IPC, PTY, git |
| PTY | [`portable-pty`](https://crates.io/crates/portable-pty) | spawn real processes (claude/shell) in pseudo-terminals |
| Rendering | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) + WebGL addon | GPU-accelerated terminal rendering |
| UI | Vanilla TS (no framework) | overview grid / depth decks / macro spiral |

PTY output streams Rust→TS over a per-session Tauri `Channel` (base64).

## Concepts (two-level model)

- **Project** — one repository/folder; a tab in the project strip.
- **Agent** — a **git worktree** of that repo (isolated branch `feature/yyyymmdd-N`); one card in the grid.
- **Layer** — an agent's Z-axis stack (`terminal` / `browser`); the front one shows, the rest deck behind it.
- **Overview / Zoom** — all agents in a grid / focused agent fullscreen.
- **Macro** — all projects spread on a golden-angle (phyllotaxis) spiral.

**Switching projects:** the grid shows one project's agents at a time. The tabs in the top strip are your open projects — click one, or press `Alt+P` to cycle. With only one project open, `Alt+P` does nothing (nothing to switch to) — open another with **📁 folder** / **⎇ clone** first. Use **✦ macro** to see all projects at once.

## Develop

```bash
pnpm install
pnpm tauri dev      # dev window
pnpm tauri build    # .app / .dmg bundle
```

Requirements: Node, Rust/cargo, pnpm, git (macOS). Tauri prerequisites: https://tauri.app/start/prerequisites/

## Keyboard (leader = Alt / Option)

| Key | Action |
|---|---|
| `Alt+T` | New agent (a worktree when the project is a git repo) |
| `Alt+←/→` (`Alt+H/L`) | Move focus between agents |
| `Alt+↑/↓` (`Alt+K/J`) | Cycle depth layers |
| `Alt+Z` | Toggle overview ⇄ zoom |
| `Alt+P` | Next project |
| `Alt+M` | Toggle macro spiral view |
| `Alt+1`–`9` | Jump to agent N + zoom |
| `Alt+N` / `Alt+B` | Add terminal / browser layer |
| `Alt+W` / `Alt+X` | Close layer / close agent |

Mouse: click a card to focus, double-click to zoom. Header dots switch layers. Double-click the title to rename (auto-named from the working directory, fixed once edited). 📁 opens a folder picker; you can also type a path.

## Toolbar

- **📁 folder / ⎇ clone** — open an existing folder / `git clone` a new project.
- **⊞ fill 9** — populate the active project with 9 agents (9 worktrees for a git repo).
- **▦ 3×3 / fit** — fixed square grid (count kept) ⇄ width-packed grid.
- **perm** — claude permission mode (`auto` / `normal` / `bypass ⚠`), default `auto`; switch to `normal` if claude won't start.
- **🛡 guard** — write a deny-list into each cwd's `.claude/settings.local.json` (added to `.git/info/exclude` so it is never committed). Configure the rules in Settings.
- **⚙ settings** — agent command, default permission mode, and the deny-list (preset toggles + custom lines).
- **✦ macro** — the golden-spiral project overview.

## Persistence & resume

- **Workspace auto-save/restore.** Projects, agents, their cwd (paths), titles, layers, layout, perm/guard/nest, agent presets all auto-save to localStorage and restore on launch — close and reopen the app and your paths/layout come back.
- **Saved project bookmarks** (`aidt-projects`): every folder you open / repo you clone is saved as a bookmark (path + editable label, save-data style), reopenable from the empty state — ✎ rename, × remove.
- **Conversation resume.** Agents launch `claude --continue`, so reopening (or respawning) a window **resumes that worktree's most recent conversation** (starts fresh if there is none). Close a window (× / `Alt+X`) and reopen later to pick up where you left off. Resume is per-directory; each worktree keeps its own thread. (Non-claude agents launch as-is.)

## Permissions & guardrails

`perm: auto` runs `claude --permission-mode auto`; a classifier reviews each action ([docs](https://code.claude.com/docs/en/permission-modes.md)). It needs a supported account/model (Opus/Sonnet 4.6+) — fall back to `normal` if claude refuses to start. `bypass` runs `--dangerously-skip-permissions` and is intended for isolated environments only.

Guardrails write a deny-list (e.g. no push to main/master, no force-push, no sudo, no curl/wget — all toggleable). The presets in `src/guard.ts` are **opinions**, not baked-in policy, so the tool stays neutral. The deny-list file is tagged `"_aidt": true`; the app updates only files it wrote and never clobbers a user-authored `settings.local.json`, and skips the home directory.

## Layout

See the module map in [`CLAUDE.md`](./CLAUDE.md). Briefly: `src/app.ts` (state/lifecycle), `render.ts` (DOM rendering), `persistence.ts` (snapshot/storage), `agent.ts` & `project.ts` (models), `guard.ts` (deny-list presets), `ui.ts` (modals/toast/picker/settings); `src-tauri/src/pty.rs` & `git.rs` (Rust commands).

## Roadmap / known limits

- Browser layer is an iframe; a native child WebView could bypass `X-Frame-Options`.
- Named/multiple saved workspaces and switching.
- Macro view pan/zoom.

## License

[MIT](./LICENSE)
