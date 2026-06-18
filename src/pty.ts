// Thin TypeScript bridge over the Rust PTY commands. Output streams back over a
// per-session Tauri Channel as base64 chunks, decoded to bytes for xterm.write().
import { invoke, Channel } from "@tauri-apps/api/core";

export interface PtyHandle {
  id: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SpawnOptions {
  id: string;
  shell: string;
  args?: string[];
  cwd?: string | null;
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
}

export async function spawnPty(opts: SpawnOptions): Promise<PtyHandle> {
  const channel = new Channel<string>();
  channel.onmessage = (b64) => opts.onData(b64ToBytes(b64));

  const pid = await invoke<number>("spawn_pty", {
    id: opts.id,
    shell: opts.shell,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
    onOutput: channel,
  });

  return {
    id: opts.id,
    pid,
    write: (data) => void invoke("write_pty", { id: opts.id, data }),
    resize: (cols, rows) => void invoke("resize_pty", { id: opts.id, cols, rows }),
    kill: () => void invoke("kill_pty", { id: opts.id }),
  };
}

export const defaultShell = (): Promise<string> => invoke("default_shell");
export const homeDir = (): Promise<string> => invoke("home_dir");
export interface AgentStat {
  cpu: number;
  cwd: string;
}
export const agentStats = (pids: number[]): Promise<AgentStat[]> =>
  invoke("agent_stats", { pids });
