//! Scan Claude Code SKILL.md files into a flat list for the in-app Skills browser.
//!
//! Skills live as `<root>/.claude/skills/<dir>/SKILL.md` (a project's `.claude` or the
//! user's `~/.claude`), and plugins ship them under `~/.claude/plugins/**/skills/<dir>/
//! SKILL.md`. Each SKILL.md opens with YAML frontmatter carrying at least `name:` and
//! `description:`. This module is read-only and tolerant: a missing/odd file is skipped,
//! never fatal, so the browser degrades cleanly when there is no `~/.claude`.
//!
//! Invocation stays human-driven — the panel TYPES the slash form into the focused
//! terminal (never auto-runs), same policy as the command palette (see CLAUDE.md). The
//! slash forms are `/ <name>` for project/user skills and `/<plugin>:<name>` for plugin
//! skills (verified against code.claude.com/docs/en/skills + slash-commands).

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// One discoverable skill. camelCase via serde so it lands TS-shaped in the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Frontmatter `name:` (fallback: the skill directory name). The slash-command stem.
    name: String,
    description: String,
    /// "project" | "user" | "plugin" — where it was found.
    source: String,
    /// Owning plugin for a plugin skill (else empty) — used for the `/plugin:name` form.
    plugin: String,
    /// Absolute path to the SKILL.md (so the UI can reveal/open it later).
    path: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// List every discoverable skill: the focused project's `.claude/skills`, the user's
/// `~/.claude/skills`, and plugin skills under `~/.claude/plugins`. `project_cwd` may be
/// empty (then only user + plugin skills are returned). Never errors on missing dirs —
/// returns an empty list so the UI degrades cleanly.
#[tauri::command]
pub fn claude_skills(project_cwd: String) -> Result<Vec<SkillInfo>, String> {
    let mut out: Vec<SkillInfo> = Vec::new();

    // Project skills (the ones a person authored/enabled in this repo).
    if !project_cwd.is_empty() {
        let dir = Path::new(&project_cwd).join(".claude").join("skills");
        scan_skills_dir(&dir, "project", "", &mut out);
    }

    if let Some(home) = home_dir() {
        // Personal skills.
        let user = home.join(".claude").join("skills");
        scan_skills_dir(&user, "user", "", &mut out);

        // Plugin skills: ~/.claude/plugins/**/skills/<dir>/SKILL.md. The plugin name is
        // the path segment just above a `skills/` folder.
        let plugins = home.join(".claude").join("plugins");
        scan_plugin_skills(&plugins, &mut out);
    }

    // Stable, readable order: source then name.
    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Read each `<dir>/<child>/SKILL.md` directly under `dir` into the list.
fn scan_skills_dir(dir: &Path, source: &str, plugin: &str, out: &mut Vec<SkillInfo>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in entries.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let md = p.join("SKILL.md");
        if !md.is_file() {
            continue;
        }
        let fallback = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if let Some(info) = read_skill(&md, source, plugin, &fallback) {
            out.push(info);
        }
    }
}

/// Walk `~/.claude/plugins` looking for any `skills/` folder, attributing each skill to
/// the directory one level above it (the plugin). Bounded recursion, and heavy/hidden
/// dirs are skipped so a stray node_modules can't make this run away.
fn scan_plugin_skills(root: &Path, out: &mut Vec<SkillInfo>) {
    fn skip(name: &str) -> bool {
        name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "build")
    }
    fn walk(dir: &Path, depth: u32, out: &mut Vec<SkillInfo>) {
        if depth > 6 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_dir() {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name == "skills" {
                // The plugin is the folder that CONTAINS this `skills/` dir.
                let plugin = dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                scan_skills_dir(&p, "plugin", &plugin, out);
            } else if !skip(name) {
                walk(&p, depth + 1, out);
            }
        }
    }
    walk(root, 0, out);
}

/// Parse SKILL.md's leading YAML frontmatter for `name` + `description`. Tolerant: no
/// frontmatter → use the directory name and an empty description.
fn read_skill(path: &Path, source: &str, plugin: &str, fallback_name: &str) -> Option<SkillInfo> {
    let f = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(f);
    let mut lines = reader.lines().map_while(Result::ok);

    let mut name = String::new();
    let mut description = String::new();

    // Frontmatter must open with a `---` line (allowing leading blank lines).
    let first = loop {
        match lines.next() {
            Some(l) if l.trim().is_empty() => continue,
            other => break other,
        }
    };
    if first.as_deref().map(str::trim) == Some("---") {
        for line in lines.by_ref() {
            let line = line.trim_end();
            if line.trim() == "---" {
                break;
            }
            if let Some(v) = line.strip_prefix("name:") {
                if name.is_empty() {
                    name = unquote(v);
                }
            } else if let Some(v) = line.strip_prefix("description:") {
                if description.is_empty() {
                    description = unquote(v);
                }
            }
        }
    }

    if name.is_empty() {
        name = fallback_name.to_string();
    }
    if name.is_empty() {
        return None;
    }
    Some(SkillInfo {
        name,
        description,
        source: source.to_string(),
        plugin: plugin.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

/// Strip matching surrounding quotes from a YAML scalar (and trim).
fn unquote(s: &str) -> String {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}
