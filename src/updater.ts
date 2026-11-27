// Auto-update: check GitHub Releases' latest.json, and (on confirm) download the
// signed update and relaunch. Wired to run quietly at startup and from a manual
// "check for updates" trigger. Requires the updater signing key to be configured —
// see docs/updater-setup.md. Safe to call before that's set up: check() just fails
// and a silent check swallows it.
//
// The macOS build is ~150MB (bundled Chromium/CEF), so the download is NOT instant.
// Without feedback it looks frozen — the user saw a restart "do nothing, get lost and
// quit". So the download now shows a live progress bar (bytes + %), and any error
// AFTER the user confirmed is always surfaced (never swallowed by `silent`).
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmModal, toast } from "./ui";
import { t } from "./i18n";

let _busy = false;

const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);

/// A non-dismissable overlay with a progress bar, themed via CSS vars. Returns handles
/// to update the fill/label and to close it. Lives here (updater's own concern) rather
/// than in ui.ts to keep this self-contained.
function progressOverlay(title: string): {
  set: (received: number, total: number) => void;
  label: (text: string) => void;
  close: () => void;
} {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal";
  box.innerHTML = `
    <div class="modal-title">${title}</div>
    <div style="height:10px;border:1px solid var(--border);border-radius:5px;overflow:hidden;background:transparent;margin:4px 0 8px">
      <div id="upd-bar" style="height:100%;width:0%;background:var(--accent);transition:width .15s linear"></div>
    </div>
    <div id="upd-label" style="font-size:12px;color:var(--muted);font-family:Menlo,monospace"></div>`;
  back.append(box);
  document.body.append(back);
  const bar = box.querySelector<HTMLElement>("#upd-bar")!;
  const lbl = box.querySelector<HTMLElement>("#upd-label")!;
  return {
    set(received, total) {
      if (total > 0) {
        bar.style.width = `${Math.min(100, Math.round((received / total) * 100))}%`;
        lbl.textContent = t("updater.progress", mb(received), mb(total));
      } else {
        // Content-Length unknown — can't show %, so show bytes and an indeterminate bar.
        bar.style.width = "100%";
        lbl.textContent = t("updater.progressUnknown", mb(received));
      }
    },
    label(text) {
      bar.style.width = "100%";
      lbl.textContent = text;
    },
    close() {
      back.remove();
    },
  };
}

/// Check for an update. `silent` (startup) shows nothing when up-to-date or on error;
/// a manual check toasts the result. Once the user CONFIRMS a download, progress and
/// any failure are shown regardless of `silent`.
export async function checkForUpdates(opts: { silent: boolean }): Promise<void> {
  if (_busy) return;
  _busy = true;
  let confirmed = false;
  let prog: ReturnType<typeof progressOverlay> | null = null;
  try {
    const update = await check();
    if (!update) {
      if (!opts.silent) toast(t("updater.upToDate"));
      return;
    }
    // Keep the prompt clean: just the version question. The release body is raw
    // Markdown (headings, tables, links) and dumping it here looked cluttered — the
    // full notes live on the GitHub release page.
    const ok = await confirmModal({
      title: t("updater.title"),
      body: t("updater.available", update.version, update.currentVersion),
      confirm: t("updater.confirm"),
    });
    if (!ok) return;
    confirmed = true;

    // Live progress — the download is large, so show bytes + %. downloadAndInstall
    // streams Started → Progress* → Finished.
    prog = progressOverlay(t("updater.downloading"));
    let received = 0;
    let total = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
        prog!.set(0, total);
      } else if (ev.event === "Progress") {
        received += ev.data.chunkLength;
        prog!.set(received, total);
      } else if (ev.event === "Finished") {
        prog!.set(total || received, total || received);
      }
    });
    prog.label(t("updater.installing"));
    await relaunch();
  } catch (e) {
    prog?.close();
    // Always surface a failure the user is waiting on; a silent startup check only
    // swallows pre-confirm errors (e.g. not configured / offline).
    if (!opts.silent || confirmed) toast(t("updater.fail", String(e)), "error");
  } finally {
    _busy = false;
  }
}
