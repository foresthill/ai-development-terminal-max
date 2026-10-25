//! Per-agent resource + cwd sampling. `agent_stats` returns, for each given pid:
//! the summed CPU% of its whole process subtree (shell + claude/aider + children)
//! and the process's current working directory (so the UI can follow `cd`).

use std::collections::HashMap;
use std::sync::Mutex;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// A long-lived System; CPU% is computed from the delta between refreshes, so it
/// is meaningful only on the 2nd+ poll (first returns ~0).
pub struct SysState(pub Mutex<System>);

impl Default for SysState {
    fn default() -> Self {
        SysState(Mutex::new(System::new()))
    }
}

#[derive(serde::Serialize)]
pub struct AgentStat {
    cpu: f32,
    mem: u64, // bytes, summed over the process subtree
    cwd: String,
    procs: u32, // processes in the subtree incl. the root shell; >1 ⇒ a command
                // (claude/aider/…) is still running, ==1 ⇒ back at an idle shell
}

/// Whether this host hits the macOS 26 (Tahoe) WKWebView compositor bug (wry#1848)
/// where the alternate screen stops presenting frames in a RELEASE build — vim/less/
/// htop draw into the DOM but the screen freezes on the first frame. The frontend
/// uses this to disable the alt-screen ONLY where the bug exists, so dev builds,
/// older macOS, Linux (WebKitGTK) and Windows (WebView2) keep normal full-screen TUIs.
///
/// DISABLED (2026-10-25): on-device testing proved the alt-screen workaround does NOT
/// help — with the alt-screen swallowed, vim renders on the NORMAL buffer (dump showed
/// `type=normal`, DOM fully populated) yet the screen is STILL frozen, because the
/// macOS 26 compositor fails to present ANY full-screen in-place redraw, on either
/// buffer. So we stop disabling the alt-screen (it only added scrollback residue with no
/// benefit) and return false everywhere. macOS 26 full-screen TUIs are unfixable inside
/// the webview; the planned answer is a DOM-based editor layer (renders as normal HTML,
/// which repaints fine). Kept as a no-op for history; see the vim journey doc.
#[tauri::command]
pub fn alt_screen_broken() -> bool {
    false
}

#[tauri::command]
pub fn agent_stats(state: tauri::State<'_, SysState>, pids: Vec<u32>) -> Vec<AgentStat> {
    let mut sys = state.0.lock().unwrap();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_cwd(UpdateKind::Always),
    );

    // parent -> children index for subtree CPU walks
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }

    pids.iter()
        .map(|&root| {
            let mut cpu = 0.0f32;
            let mut mem = 0u64;
            let mut procs = 0u32;
            let mut stack = vec![root];
            while let Some(p) = stack.pop() {
                if let Some(proc_) = sys.process(Pid::from_u32(p)) {
                    cpu += proc_.cpu_usage();
                    mem += proc_.memory();
                    procs += 1;
                }
                if let Some(kids) = children.get(&p) {
                    stack.extend(kids);
                }
            }
            let cwd = sys
                .process(Pid::from_u32(root))
                .and_then(|p| p.cwd())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            AgentStat { cpu, mem, cwd, procs }
        })
        .collect()
}
