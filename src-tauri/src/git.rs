//! Git helpers for the Project layer: detect repos, clone new ones, and create
//! per-agent worktrees so parallel Claude Code agents work on isolated branches
//! of the same repository without stepping on each other.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_git(args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn workspace_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    Path::new(&home).join("aidt-workspaces")
}

/// True if `path` is inside a git work tree.
#[tauri::command]
pub fn is_git_repo(path: String) -> bool {
    run_git(&["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

/// Current branch of the repo at `dir` (e.g. "main", "feature/x"), or "" if not
/// a git work tree. Used for the always-visible branch badge.
#[tauri::command]
pub fn current_branch(dir: String) -> String {
    run_git(&["-C", &dir, "rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default()
}

/// Clone `url` into ~/aidt-workspaces/<repo> and return the local path.
#[tauri::command]
pub fn git_clone(url: String) -> Result<String, String> {
    let root = workspace_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir failed: {e}"))?;
    let name = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .to_string();
    let dest = root.join(if name.is_empty() { "repo" } else { &name });
    let dest_str = dest.to_string_lossy().to_string();
    if dest.exists() {
        return Err(format!("destination already exists: {dest_str}"));
    }
    run_git(&["clone", &url, &dest_str])?;
    Ok(dest_str)
}

/// Create a new worktree of `repo_path` on a fresh `branch`, returning its path.
/// Worktrees live under <repo-parent>/.aidt-worktrees/<repo>/<branch>.
#[tauri::command]
pub fn create_worktree(repo_path: String, branch: String) -> Result<String, String> {
    let repo = Path::new(&repo_path);
    let repo_name = repo
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let parent = repo
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| repo.to_path_buf());
    let safe_branch = branch.replace('/', "-");
    let wt_root = parent.join(".aidt-worktrees").join(&repo_name);
    std::fs::create_dir_all(&wt_root).map_err(|e| format!("mkdir failed: {e}"))?;
    let wt = wt_root.join(&safe_branch);
    let wt_str = wt.to_string_lossy().to_string();
    if wt.exists() {
        return Err(format!("worktree already exists: {wt_str}"));
    }
    run_git(&["-C", &repo_path, "worktree", "add", &wt_str, "-b", &branch])?;
    Ok(wt_str)
}

/// Opt-in guardrails: write a `.claude/settings.local.json` deny-list into `dir`
/// (blocks pushes to main/master, force-push, sudo, curl/wget). Because we create
/// the file ourselves, also add it to the repo's local git exclude so it is never
/// committed. Deny syntax per https://code.claude.com/docs/en/permissions.md
#[tauri::command]
pub fn write_guardrails(dir: String, deny: Vec<String>) -> Result<(), String> {
    let claude_dir = Path::new(&dir).join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| format!("mkdir failed: {e}"))?;

    // Tag our file so we may update it later without ever clobbering a file the
    // user wrote themselves.
    let json = serde_json::json!({ "_aidt": true, "permissions": { "deny": deny } });
    let content = serde_json::to_string_pretty(&json).map_err(|e| format!("json failed: {e}"))? + "\n";

    let file = claude_dir.join("settings.local.json");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if !existing.contains("\"_aidt\"") {
            return Ok(()); // user's own file — leave it untouched
        }
    }
    std::fs::write(&file, content).map_err(|e| format!("write failed: {e}"))?;

    // Keep our local-only file out of version control.
    if let Ok(common) = run_git(&["-C", &dir, "rev-parse", "--git-common-dir"]) {
        let common_path = if Path::new(&common).is_absolute() {
            PathBuf::from(&common)
        } else {
            Path::new(&dir).join(&common)
        };
        let exclude = common_path.join("info").join("exclude");
        let line = ".claude/settings.local.json";
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !existing.contains(line) {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&exclude) {
                let _ = writeln!(f, "{line}");
            }
        }
    }
    Ok(())
}
