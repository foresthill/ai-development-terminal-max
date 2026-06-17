// Bridge to the Rust git commands used by the Project layer.
import { invoke } from "@tauri-apps/api/core";

export const isGitRepo = (path: string): Promise<boolean> => invoke("is_git_repo", { path });
export const gitClone = (url: string): Promise<string> => invoke("git_clone", { url });
export const createWorktree = (repoPath: string, branch: string): Promise<string> =>
  invoke("create_worktree", { repoPath, branch });
export const writeGuardrails = (dir: string, deny: string[]): Promise<void> =>
  invoke("write_guardrails", { dir, deny });
