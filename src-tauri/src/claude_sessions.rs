//! Harvest Claude Code's OWN session transcripts into compact digests.
//!
//! Claude stores each session as `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
//! (one JSON object per line). That storage is NOT reliable — sessions can fail to
//! resume or disappear — so this app reads them only as a *fragile source* and then
//! persists its own durable long-term memory (see memory.rs + the 2026-11-10 harvest
//! design doc). This module is read-only: it scans the jsonl files and returns one
//! `SessionDigest` per session; persisting + overview happen in TS.
//!
//! Parsing is deliberately tolerant: Claude's line schema may change, and real files
//! mix human turns, tool results, summaries and meta lines. Missing/odd keys are
//! skipped rather than failing the whole scan.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// A compact, durable summary of one Claude session. camelCase via serde so it lands
/// in the webview already shaped for TS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDigest {
    /// Claude's session UUID (the jsonl filename stem, confirmed against the `sessionId`
    /// field). Stable key for dedupe when sedimenting into our store.
    session_id: String,
    /// The real working directory, taken from the line's `cwd` (not decoded from the
    /// lossy `/`→`-` directory name).
    cwd: String,
    /// Last path segment of `cwd` — a readable project label for the overview.
    project: String,
    git_branch: String,
    /// Claude's generated session slug, e.g. "dreamy-hugging-shore".
    slug: String,
    /// First real human message (text), else the slug — a human-readable title.
    title: String,
    /// ISO timestamps of the first and last line carrying one.
    first_ts: String,
    last_ts: String,
    /// Count of lines that carry a `message.role` (real turns, not meta/summary lines).
    messages: u32,
}

/// `~/.claude/projects`, or None when there is no home dir / the folder is absent.
fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let dir = PathBuf::from(home).join(".claude").join("projects");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Digest every Claude session on this machine, newest activity first. When `only_cwd`
/// is non-empty, keep only sessions whose `cwd` equals it (one project). Never errors on
/// a missing `~/.claude` — returns an empty list so the UI degrades cleanly.
#[tauri::command]
pub fn claude_sessions(only_cwd: String) -> Result<Vec<SessionDigest>, String> {
    let root = match claude_projects_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let mut out: Vec<SessionDigest> = Vec::new();
    let projects = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let fpath = file.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(d) = digest_file(&fpath) {
                if only_cwd.is_empty() || d.cwd == only_cwd {
                    out.push(d);
                }
            }
        }
    }
    out.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    Ok(out)
}

/// Stream one jsonl file into a digest. Returns None when it carries no `sessionId`
/// (not a real session file).
fn digest_file(path: &Path) -> Option<SessionDigest> {
    let f = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(f);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut git_branch = String::new();
    let mut slug = String::new();
    let mut title = String::new();
    let mut first_ts = String::new();
    let mut last_ts = String::new();
    let mut messages: u32 = 0;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // tolerate a malformed line
        };

        if session_id.is_empty() {
            if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                session_id = s.to_string();
            }
        }
        if cwd.is_empty() {
            if let Some(s) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = s.to_string();
            }
        }
        if git_branch.is_empty() {
            if let Some(s) = v.get("gitBranch").and_then(|x| x.as_str()) {
                git_branch = s.to_string();
            }
        }
        if slug.is_empty() {
            if let Some(s) = v.get("slug").and_then(|x| x.as_str()) {
                slug = s.to_string();
            }
        }
        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
            if first_ts.is_empty() {
                first_ts = ts.to_string();
            }
            last_ts = ts.to_string();
        }

        // A real turn has message.role; count it, and grab the first human text as title.
        if let Some(msg) = v.get("message") {
            if msg.get("role").and_then(|r| r.as_str()).is_some() {
                messages += 1;
                if title.is_empty()
                    && v.get("type").and_then(|t| t.as_str()) == Some("user")
                {
                    if let Some(t) = first_human_text(msg) {
                        title = t;
                    }
                }
            }
        }
    }

    if session_id.is_empty() {
        // Fall back to the filename stem (sessions are named by their id).
        session_id = path.file_stem().and_then(|s| s.to_str())?.to_string();
    }
    if title.is_empty() {
        title = slug.clone();
    }
    let project = Path::new(&cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    Some(SessionDigest {
        session_id,
        cwd,
        project,
        git_branch,
        slug,
        title,
        first_ts,
        last_ts,
        messages,
    })
}

/// Extract the first human-authored text from a message's `content`, skipping tool
/// results and harness-injected `<...>` blocks (so the title reads like something a
/// person typed). `content` is either a string or a list of typed blocks.
fn first_human_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        return clean_human(s);
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = block.get("text").and_then(|x| x.as_str()) {
                    if let Some(c) = clean_human(s) {
                        return Some(c);
                    }
                }
            }
        }
    }
    None
}

/// Trim a candidate title; reject empty, tool-result-ish and harness `<...>` openers.
fn clean_human(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.starts_with('<') {
        return None;
    }
    Some(s.chars().take(100).collect())
}
