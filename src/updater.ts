// Auto-update: check GitHub Releases' latest.json, and (on confirm) download the
// signed update and relaunch. Wired to run quietly at startup and from a manual
// "check for updates" trigger. Requires the updater signing key to be configured —
// see docs/updater-setup.md. Safe to call before that's set up: check() just fails
// and a silent check swallows it.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmModal, toast } from "./ui";
import { t } from "./i18n";

let _busy = false;

/// Check for an update. `silent` (startup) shows nothing when up-to-date or on error;
/// a manual check toasts the result.
export async function checkForUpdates(opts: { silent: boolean }): Promise<void> {
  if (_busy) return;
  _busy = true;
  try {
    const update = await check();
    if (!update) {
      if (!opts.silent) toast(t("updater.upToDate"));
      return;
    }
    const notes = (update.body ?? "").trim().slice(0, 300);
    const ok = await confirmModal({
      title: t("updater.title"),
      body: t("updater.available", update.version, update.currentVersion) + (notes ? `\n\n${notes}` : ""),
      confirm: t("updater.confirm"),
    });
    if (!ok) return;
    toast(t("updater.downloading"));
    await update.downloadAndInstall();
    toast(t("updater.installing"));
    await relaunch();
  } catch (e) {
    if (!opts.silent) toast(t("updater.fail", String(e)), "error");
  } finally {
    _busy = false;
  }
}
