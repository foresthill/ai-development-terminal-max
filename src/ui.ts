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

/// Yes/no confirmation. Resolves true on confirm, false on cancel/Escape/backdrop.
/// Focus defaults to Cancel so a stray Enter doesn't confirm a destructive action.
export function confirmModal(opts: {
  title: string;
  body?: string;
  confirm?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal";
    const h = document.createElement("div");
    h.className = "modal-title";
    h.textContent = opts.title;
    box.append(h);
    if (opts.body) {
      const b = document.createElement("div");
      b.className = "modal-body";
      b.textContent = opts.body;
      box.append(b);
    }
    const row = document.createElement("div");
    row.className = "modal-row";
    const cancel = document.createElement("button");
    cancel.textContent = t("modal.cancel");
    const ok = document.createElement("button");
    ok.textContent = opts.confirm ?? t("modal.ok");
    ok.className = opts.danger ? "danger" : "primary";
    row.append(cancel, ok);
    box.append(row);
    back.append(box);
    document.body.append(back);
    const done = (v: boolean) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
    };
    document.addEventListener("keydown", onKey, true);
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    back.onclick = (e) => {
      if (e.target === back) done(false);
    };
    setTimeout(() => cancel.focus(), 0);
  });
}

import { GUARD_PRESETS } from "./guard";
import { t, Lang, getLang } from "./i18n";

const HELP_JA = `
<h4>概念（3つの軸）</h4>
<ul>
  <li><b>Project（プロジェクト）</b>＝リポ/フォルダ1つ。上部タブ＝開いているプロジェクト。<code>📁/⎇</code>で追加、<code>Alt+P</code>・タブ・<code>✦macro</code>で切替。</li>
  <li><b>Agent（ウィンドウ）</b>＝プロジェクト内の git worktree で動く<b>メインエージェント1個</b>（claude/codex/…）。グリッドに横並びで<b>並列稼働</b>。</li>
  <li><b>Subagent</b>＝claude が Task で生む子。そのウィンドウ内に<b>🪆入れ子カード</b>で表示（nest ON時）。別ウィンドウではない。</li>
  <li><b>Layer（奥行き）</b>＝1ウィンドウのZ軸スタック（端末/ブラウザ）。タブで切替。</li>
</ul>
<h4>キーボード（leader = Alt / Option）</h4>
<ul>
  <li><code>Alt+T</code> 追加 ・ <code>Alt+←/→</code> エージェント移動 ・ <code>Alt+↑/↓</code> 奥行き</li>
  <li><code>Alt+Z</code> 拡大 ・ <code>Alt+1–9</code> 番号でフォーカス ・ <code>Alt+P</code> プロジェクト切替 ・ <code>Alt+M</code> 俯瞰</li>
  <li><code>Alt+N</code> 端末追加 ・ <code>Alt+B</code> ブラウザ追加 ・ <code>Alt+W</code> レイヤー閉 ・ <code>Alt+X</code> エージェント閉</li>
  <li><code>Alt+R</code> このエージェントを起動 ・ <code>Alt+Shift+R</code> 全起動 ・ <code>Alt+Enter</code> 送信バー</li>
  <li><code>Shift+Enter</code> 端末内で改行（Claude Codeの改行）・ <code>⌘C/⌘V</code> コピー/貼付</li>
  <li>URL: クリックでブラウザに開く（既定=アプリ内、設定で変更可）・ <code>⌘/Ctrl+クリック</code>でもう片方のブラウザ ／ ファイルパス: <code>⌘/Ctrl+クリック</code>でOS標準アプリ</li>
  <li>選択: <code>クリック</code>で始点→<code>Shift+クリック</code>で範囲指定（claude上でも可）。ドラッグ選択はシェルではそのまま、claude上は <code>⌥(Option)+ドラッグ</code></li>
</ul>
<h4>ツールバー</h4>
<ul>
  <li><b>+ エージェント / ⊞ fill</b>：メインエージェント（worktree）を追加 ・ <b>▶ 全起動</b>：未起動を一括起動</li>
  <li><b>⤢ 拡大 / ▦ グリッド / ✦ 俯瞰</b>：表示切替 ・ <b>↗ 送信</b>：別エージェントへ1行注入</li>
  <li><b>perm</b>：claudeのパーミッション ・ <b>🛡 guard</b>：deny-list ・ <b>🪆 nest</b>：サブエージェント検知</li>
  <li><b>📁/⎇</b>：プロジェクト追加 ・ <b>💾 セーブ</b>：名前付き保存/読込 ・ <b>⚙ 設定</b></li>
</ul>
<h4>各ウィンドウ</h4>
<ul>
  <li><b>▶</b> エージェント起動（<code>--continue</code>で会話再開） ・ <b>×</b> 閉じる ・ プルダウンでエージェント種別</li>
  <li>バッジ <b>⚡CPU% · RAM</b>、<b>⎇ブランチ</b> ・ タイトルはダブルクリックで改名 ・ 📁でcwd選択</li>
</ul>
<h4>永続化と再開</h4>
<ul>
  <li>ワークスペース（パス/レイアウト等）は自動保存・起動時に復元。</li>
  <li><b>前回動いていたウィンドウだけ</b>復元時に自動再開、他はshellのまま（▶で起動）。</li>
  <li><b>💾 セーブ</b>で状態を名前付きスロットに保存・切替。</li>
  <li>履歴はclaude本体が逐次保存するので、クラッシュ後も再開できます。</li>
</ul>`;

const HELP_EN = `
<h4>Concepts (three axes)</h4>
<ul>
  <li><b>Project</b> = one repo/folder. Top tabs = open projects. Add with <code>📁/⎇</code>; switch with <code>Alt+P</code> / tabs / <code>✦ macro</code>.</li>
  <li><b>Agent (window)</b> = one <b>main agent</b> (claude/codex/…) in a git worktree of the project. The grid runs them <b>in parallel</b>.</li>
  <li><b>Subagent</b> = a child a claude spawns via the Task tool; shown as a <b>🪆 nested card</b> inside that window (nest ON). Not a separate window.</li>
  <li><b>Layer</b> = a window's Z-axis stack (terminal/browser); switch via tabs.</li>
</ul>
<h4>Keyboard (leader = Alt / Option)</h4>
<ul>
  <li><code>Alt+T</code> new ・ <code>Alt+←/→</code> move focus ・ <code>Alt+↑/↓</code> depth</li>
  <li><code>Alt+Z</code> zoom ・ <code>Alt+1–9</code> focus by number ・ <code>Alt+P</code> switch project ・ <code>Alt+M</code> macro</li>
  <li><code>Alt+N</code> terminal ・ <code>Alt+B</code> browser ・ <code>Alt+W</code> close layer ・ <code>Alt+X</code> close agent</li>
  <li><code>Alt+R</code> launch this agent ・ <code>Alt+Shift+R</code> launch all ・ <code>Alt+Enter</code> send bar</li>
  <li><code>Shift+Enter</code> newline in terminal (Claude Code) ・ <code>⌘C/⌘V</code> copy/paste</li>
  <li>URL: click opens it in the browser (default = in-app, configurable) ・ <code>⌘/Ctrl+click</code> = the other browser ／ file path: <code>⌘/Ctrl+click</code> = OS default app</li>
  <li>Select: <code>click</code> the start → <code>Shift+click</code> the end for a range (works in claude too). Drag-select works in shells; in claude use <code>⌥(Option)+drag</code></li>
</ul>
<h4>Toolbar</h4>
<ul>
  <li><b>+ agent / ⊞ fill</b>: add main agents (worktrees) ・ <b>▶ all</b>: launch all idle windows</li>
  <li><b>⤢ zoom / ▦ grid / ✦ macro</b>: views ・ <b>↗ send</b>: inject a line into another agent</li>
  <li><b>perm</b>: claude permission ・ <b>🛡 guard</b>: deny-list ・ <b>🪆 nest</b>: subagent detection</li>
  <li><b>📁/⎇</b>: add project ・ <b>💾 saves</b>: named save/load ・ <b>⚙ settings</b></li>
</ul>
<h4>Per window</h4>
<ul>
  <li><b>▶</b> launch the agent (<code>--continue</code> resumes) ・ <b>×</b> close ・ dropdown picks the agent</li>
  <li>badges <b>⚡CPU% · RAM</b>, <b>⎇ branch</b> ・ double-click the title to rename ・ 📁 picks cwd</li>
</ul>
<h4>Persistence & resume</h4>
<ul>
  <li>Workspace (paths/layout/…) auto-saves and restores on launch.</li>
  <li>On restore, <b>only windows that were running</b> auto-resume; others stay shells (▶ to run).</li>
  <li><b>💾 saves</b>: keep named slots and switch between them.</li>
  <li>claude writes its transcript continuously, so conversations survive a crash.</li>
</ul>`;

/// In-app help: concepts, shortcuts, toolbar, persistence. Follows the language.
export function openHelp() {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-help";
  box.innerHTML = `
    <div class="modal-title">${t("help.title")}</div>
    <div class="help-body">${getLang() === "ja" ? HELP_JA : HELP_EN}</div>
    <div class="modal-row"><button id="help-close" class="primary">${t("modal.ok")}</button></div>`;
  back.append(box);
  document.body.append(back);
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey, true);
  box.querySelector("#help-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
}

export interface SettingsValues {
  lang: Lang;
  agentCmd: string;
  permMode: "auto" | "normal" | "bypass";
  enabled: Set<string>;
  customDeny: string;
  agentPresets: { label: string; cmd: string }[];
  urlExternal: boolean;
}

function parsePresets(text: string): { label: string; cmd: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("=");
      if (i < 0) return { label: line, cmd: line };
      return { label: line.slice(0, i).trim() || line, cmd: line.slice(i + 1).trim() };
    })
    .filter((p) => p.cmd);
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
      <label class="set-row col"><span>${t("set.presets")}</span>
        <textarea class="modal-input" id="set-agents" rows="4" spellcheck="false"
          placeholder="claude = claude"></textarea></label>
      <label class="set-row"><span>${t("set.perm")}</span>
        <select class="modal-input" id="set-perm">
          <option value="auto">auto</option><option value="normal">normal</option>
          <option value="bypass">bypass ⚠</option>
        </select></label>
      <label class="set-row"><span>${t("set.urlTarget")}</span>
        <select class="modal-input" id="set-url">
          <option value="inapp">${t("set.urlInapp")}</option>
          <option value="external">${t("set.urlExternal")}</option>
        </select></label>
      <div class="set-hint">${t("set.urlHint")}</div>
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
    const agents = box.querySelector<HTMLTextAreaElement>("#set-agents")!;
    const perm = box.querySelector<HTMLSelectElement>("#set-perm")!;
    const urlSel = box.querySelector<HTMLSelectElement>("#set-url")!;
    const custom = box.querySelector<HTMLTextAreaElement>("#set-custom")!;
    const presetsEl = box.querySelector<HTMLElement>("#set-presets")!;
    langSel.value = cur.lang;
    cmd.value = cur.agentCmd;
    agents.value = cur.agentPresets.map((p) => `${p.label} = ${p.cmd}`).join("\n");
    perm.value = cur.permMode;
    urlSel.value = cur.urlExternal ? "external" : "inapp";
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
        agentPresets: parsePresets(agents.value),
        urlExternal: urlSel.value === "external",
      });
    });
    back.addEventListener("click", (e) => {
      if (e.target === back) done(null);
    });
    setTimeout(() => cmd.focus(), 0);
  });
}

export interface SavesController {
  list(): string[];
  saveAs(name: string): void;
  load(name: string): Promise<boolean>; // resolves true if the slot was loaded
  remove(name: string): void;
}

/// Named save-slots dialog: save the current workspace under a name, or load /
/// delete an existing slot. Stays open across save/delete; closes on load.
export function openSavesDialog(c: SavesController) {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide";
  box.innerHTML = `
    <div class="modal-title">${t("saves.title")}</div>
    <div class="modal-body">${t("saves.intro")}</div>
    <div class="set-section">${t("saves.saveSection")}</div>
    <div class="set-row"><input class="modal-input" id="save-name" spellcheck="false"
        placeholder="${t("saves.placeholder")}"><button class="primary" id="save-go">💾 ${t("saves.saveAs")}</button></div>
    <div class="set-section">${t("saves.loadSection")}</div>
    <div id="save-list"></div>
    <div class="modal-row"><button id="save-close">${t("saves.close")}</button></div>`;
  back.append(box);
  document.body.append(back);

  const nameInput = box.querySelector<HTMLInputElement>("#save-name")!;
  const listEl = box.querySelector<HTMLElement>("#save-list")!;
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey, true);

  const refresh = () => {
    listEl.replaceChildren();
    const names = c.list();
    if (!names.length) {
      const empty = document.createElement("div");
      empty.className = "saves-empty";
      empty.textContent = t("saves.empty");
      listEl.appendChild(empty);
      return;
    }
    for (const name of names) {
      const row = document.createElement("div");
      row.className = "saved-row";
      // The slot name is a plain label — NOT a load trigger. Loading and
      // overwriting are explicit, separate buttons so neither is a surprise.
      const nm = document.createElement("span");
      nm.className = "saved-name";
      nm.textContent = `💾 ${name}`;
      const over = document.createElement("button");
      over.className = "saved-act";
      over.textContent = t("saves.overwrite");
      over.title = t("saves.overwriteTip");
      over.addEventListener("click", async () => {
        const ok = await confirmModal({
          title: t("saves.confirmOverwrite", name),
          confirm: t("saves.overwriteBtn"),
          danger: true,
        });
        if (ok) {
          c.saveAs(name);
          refresh();
        }
      });
      const load = document.createElement("button");
      load.className = "saved-load";
      load.textContent = t("saves.load");
      load.title = t("saves.loadTip");
      load.addEventListener("click", async () => {
        // load() confirms (it replaces the current workspace) and auto-backs-up;
        // only close the dialog if the user went through with it.
        if (await c.load(name)) close();
      });
      const del = document.createElement("button");
      del.className = "saved-act";
      del.textContent = "×";
      del.title = t("saves.remove");
      del.addEventListener("click", () => {
        c.remove(name);
        refresh();
      });
      row.append(nm, over, load, del);
      listEl.appendChild(row);
    }
  };
  refresh();

  const doSave = () => {
    const n = nameInput.value.trim();
    if (!n) return;
    c.saveAs(n);
    nameInput.value = "";
    refresh();
  };
  box.querySelector("#save-go")!.addEventListener("click", doSave);
  nameInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") doSave();
  });
  box.querySelector("#save-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  setTimeout(() => nameInput.focus(), 0);
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
