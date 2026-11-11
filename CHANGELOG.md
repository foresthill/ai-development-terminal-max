# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project aims for
[Semantic Versioning](https://semver.org/).

## [0.1.13] - 2026-11-11

### Added
- **Automatic Claude-session long-term memory.** The app harvests Claude Code's
  own sessions (`~/.claude/projects/*.jsonl`) and preserves compact digests in
  its durable SQLite store, so a session survives even if Claude later loses it.
  A global **session overview** (all projects, with a "resume" action) and a
  heuristic **Insights** view (per-project + cross-project stats, frequent
  topics) read from the preserved data. Portable Markdown/JSON export/import
  (no lock-in). The manual note-entry form was removed.

### Changed
- Minimal "liquid glass" UI cleanup: flat glass panels (heavy drop shadow
  removed) and a simplified update-check dialog.

### Fixed
- **cwd drift / claude respawn.** The live "follow cd" display no longer
  overwrites an agent's *set* working directory. Previously it could make new
  shell layers spawn in the wrong project, revert the user's path edits, and —
  when the path was corrected — respawn the primary (claude) layer, killing its
  session/venv. The live directory is now shown as display-only (tooltip + a
  subtle "drift" marker) and never mutates the canonical cwd.
- **Release build.** Enabled the `macos-private-api` crate feature to match
  `macOSPrivateApi` in `tauri.conf.json`, and aligned `@tauri-apps/api` (npm)
  with the `tauri` crate on 2.12 so `tauri build` no longer rejects a version
  mismatch.

## [0.1.12] - unreleased

The release build failed on CI: `tauri build` rejected a version mismatch
between the `tauri` crate (2.12.5) and `@tauri-apps/api` (2.11.0), so no
artifacts were published. The intended changes plus the fix shipped in 0.1.13.
The commit (`Merge … v0.1.12`) remains in history; the unused `v0.1.12` tag can
be removed without losing anything.

## [0.1.12-beta.1] - 2026-11-10 (pre-release)

### Added
- Native macOS window vibrancy (translucent "liquid glass" background) via
  `macOSPrivateApi` + `windowEffects`.

### Notes
- The Windows MSI build rejects a non-numeric pre-release version — use a numeric
  version (e.g. 0.1.12) for an all-OS release.

## [0.1.11] - 2026-11-09

### Changed
- Minimal, monochrome "glass" UI: icon-only toolbar and muted colour tokens.

## [0.1.10] - 2026-11-09

### Added
- Claude Code command palette (Alt+C) and a per-launch session model.

## [0.1.9] - 2026-11-09

### Added
- Canonical SQLite memory store (`~/.aidt/memory.db`) — durable, inspectable and
  portable — as the source of truth in place of localStorage.

## [0.1.8]

### Added
- Apple Developer ID code-signing + notarization for the macOS build.

## [0.1.7]

### Added
- Native application menu (built via `@tauri-apps/api/menu`).

## [0.1.6]

### Added
- Application menu with a manual "Check for updates".

## [0.1.5]

### Added
- DOM-based editor layer (to edit on macOS 26, where terminal vim can't
  repaint), an auto-updater, and a session-restore fix.
