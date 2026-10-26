// Bridges to the Rust file commands + the native file-open dialog, for the editor
// layer (src/editor.ts). The editor exists because terminal vim can't repaint on
// macOS 26 (see docs/2026-10-24-macos26-wkwebview-altscreen.md) — a DOM editor does.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export const readFile = (path: string): Promise<string> => invoke("read_file", { path });
export const writeFile = (path: string, contents: string): Promise<void> =>
  invoke("write_file", { path, contents });

/// Native "open file" dialog → absolute path, or null if cancelled.
export async function pickFile(defaultPath?: string): Promise<string | null> {
  const res = await open({ directory: false, multiple: false, defaultPath });
  return typeof res === "string" ? res : null;
}

/// Native "save as" dialog → absolute path, or null if cancelled.
export async function pickSavePath(defaultPath?: string): Promise<string | null> {
  const res = await save({ defaultPath });
  return typeof res === "string" ? res : null;
}
