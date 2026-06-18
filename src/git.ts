// Bridge to the Rust git commands used by the Project layer.
import { invoke } from "@tauri-apps/api/core";

export const isGitRepo = (path: string): Promise<boolean> => invoke("is_git_repo", { path });
export const currentBranch = (dir: string): Promise<string> => invoke("current_branch", { dir });
export const gitClone = (url: string): Promise<string> => invoke("git_clone", { url });
export const createWorktree = (repoPath: string, branch: string): Promise<string> =>
  invoke("create_worktree", { repoPath, branch });
export const writeAidtSettings = (
  dir: string,
  deny: string[],
  subagentHooks: boolean
): Promise<void> => invoke("write_aidt_settings", { dir, deny, subagentHooks });
