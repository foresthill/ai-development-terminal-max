// Minimal modal + toast helpers (the Tauri webview's native prompt/alert are
// unreliable). askText resolves to the entered string, or null on cancel.
import { open } from "@tauri-apps/plugin-dialog";

/// Native folder picker. Returns the chosen absolute path, or null on cancel.
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, defaultPath });
  return typeof res === "string" ? res : null;
}

export function askText(opts: {
  title: string;
  placeholder?: string;
  value?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal";
    const h = document.createElement("div");
    h.className = "modal-title";
    h.textContent = opts.title;
    const inp = document.createElement("input");
    inp.className = "modal-input";
    inp.placeholder = opts.placeholder ?? "";
    inp.value = opts.value ?? "";
    inp.spellcheck = false;
    const row = document.createElement("div");
    row.className = "modal-row";
    const cancel = document.createElement("button");
    cancel.textContent = "キャンセル";
    const ok = document.createElement("button");
    ok.textContent = "OK";
    ok.className = "primary";
    row.append(cancel, ok);
    box.append(h, inp, row);
    back.append(box);
    document.body.append(back);

    const done = (v: string | null) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter") done(inp.value.trim() || null);
    };
    document.addEventListener("keydown", onKey, true);
    ok.onclick = () => done(inp.value.trim() || null);
    cancel.onclick = () => done(null);
    back.onclick = (e) => {
      if (e.target === back) done(null);
    };
    setTimeout(() => inp.focus(), 0);
  });
}

import { GUARD_PRESETS } from "./guard";
import { t, Lang } from "./i18n";

export interface SettingsValues {
  lang: Lang;
  agentCmd: string;
  permMode: "auto" | "normal" | "bypass";
  enabled: Set<string>;
  customDeny: string;
}

/// Settings dialog: agent command, permission default, and the guardrail
/// deny-list toggles. Resolves to the new values, or null on cancel.
export function openSettings(cur: SettingsValues): Promise<SettingsValues | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal modal-wide";
    box.innerHTML = `
      <div class="modal-title">${t("set.title")}</div>
      <label class="set-row"><span>${t("set.lang")}</span>
        <select class="modal-input" id="set-lang">
          <option value="en">English</option><option value="ja">日本語</option>
        </select></label>
      <label class="set-row"><span>${t("set.agentCmd")}</span>
        <input class="modal-input" id="set-cmd" spellcheck="false"></label>
      <label class="set-row"><span>${t("set.perm")}</span>
        <select class="modal-input" id="set-perm">
          <option value="auto">auto</option><option value="normal">normal</option>
          <option value="bypass">bypass ⚠</option>
        </select></label>
      <div class="set-section">${t("set.guardSection")}</div>
      <div id="set-presets"></div>
      <label class="set-row col"><span>${t("set.customDeny")}</span>
        <textarea class="modal-input" id="set-custom" rows="3" spellcheck="false"
          placeholder="Bash(rm -rf *)"></textarea></label>
      <div class="modal-row"><button id="set-cancel">${t("modal.cancel")}</button>
        <button id="set-ok" class="primary">${t("modal.ok")}</button></div>`;
    back.append(box);
    document.body.append(back);

    const langSel = box.querySelector<HTMLSelectElement>("#set-lang")!;
    const cmd = box.querySelector<HTMLInputElement>("#set-cmd")!;
    const perm = box.querySelector<HTMLSelectElement>("#set-perm")!;
    const custom = box.querySelector<HTMLTextAreaElement>("#set-custom")!;
    const presetsEl = box.querySelector<HTMLElement>("#set-presets")!;
    langSel.value = cur.lang;
    cmd.value = cur.agentCmd;
    perm.value = cur.permMode;
    custom.value = cur.customDeny;
    const boxes: Record<string, HTMLInputElement> = {};
    for (const p of GUARD_PRESETS) {
      const row = document.createElement("label");
      row.className = "set-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cur.enabled.has(p.id);
      boxes[p.id] = cb;
      const span = document.createElement("span");
      span.textContent = t(p.label);
      row.append(cb, span);
      presetsEl.appendChild(row);
    }

    const done = (v: SettingsValues | null) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
    };
    document.addEventListener("keydown", onKey, true);
    box.querySelector("#set-cancel")!.addEventListener("click", () => done(null));
    box.querySelector("#set-ok")!.addEventListener("click", () => {
      const enabled = new Set<string>();
      for (const id of Object.keys(boxes)) if (boxes[id].checked) enabled.add(id);
      done({
        lang: langSel.value as Lang,
        agentCmd: cmd.value.trim() || "claude",
        permMode: perm.value as SettingsValues["permMode"],
        enabled,
        customDeny: custom.value,
      });
    });
    back.addEventListener("click", (e) => {
      if (e.target === back) done(null);
    });
    setTimeout(() => cmd.focus(), 0);
  });
}

export function toast(message: string, kind: "info" | "error" = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4200);
}
