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
