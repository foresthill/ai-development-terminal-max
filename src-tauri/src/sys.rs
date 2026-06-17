//! Per-agent resource usage. `cpu_usage` returns the summed CPU% of each given
//! pid's whole process subtree (the shell + claude/aider + their children), so a
//! window's badge reflects the real work, not just the wrapper shell.

use std::collections::HashMap;
use std::sync::Mutex;

use sysinfo::{Pid, ProcessesToUpdate, System};

/// A long-lived System; CPU% is computed from the delta between refreshes, so it
/// is meaningful only on the 2nd+ poll (first returns ~0).
pub struct SysState(pub Mutex<System>);

impl Default for SysState {
    fn default() -> Self {
        SysState(Mutex::new(System::new()))
    }
}

#[tauri::command]
pub fn cpu_usage(state: tauri::State<'_, SysState>, pids: Vec<u32>) -> Vec<f32> {
    let mut sys = state.0.lock().unwrap();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    // parent -> children index for subtree walks
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }

    pids.iter()
        .map(|&root| {
            let mut total = 0.0f32;
            let mut stack = vec![root];
            while let Some(p) = stack.pop() {
                if let Some(proc_) = sys.process(Pid::from_u32(p)) {
                    total += proc_.cpu_usage();
                }
                if let Some(kids) = children.get(&p) {
                    stack.extend(kids);
                }
            }
            total
        })
        .collect()
}
