// Minimal i18n: t(key) lookup + static-DOM application + persisted language.
// Default language follows the browser, override via Settings. English is the
// fallback for any missing key.
export type Lang = "en" | "ja";

const en: Record<string, string> = {
  "btn.add": "＋ agent",
  "btn.fill": "⊞ fill 9",
  "btn.zoom": "⤢ zoom",
  "btn.macro": "✦ macro",
  "btn.send": "↗ send",
  "btn.folder": "📁 folder",
  "btn.clone": "⎇ clone",
  "btn.settings": "⚙ Settings",
  "lbl.perm": "perm",
  "unit.agents": "agents",
  "unit.proj": "proj",
  "layout.fit": "fit",
  "guard.label": "guard",
  "nest.label": "nest",
  "on": "on",
  "off": "off",
  "tip.nest": "nest subagents: pop a card when Claude Code spawns a subagent (installs SubagentStart/Stop hooks per worktree)",
  "toast.nestOn": "subagent nesting ON — hooks written (effective after claude restarts)",
  "toast.nestOff": "subagent nesting OFF — hooks removed, nested cards cleared",
  "subagent.running": "running…",
  "empty.title": "Open a project to start",
  "empty.saved": "Saved projects",
  "saved.rename": "rename",
  "saved.remove": "remove",
  "saved.renameTitle": "Rename saved project",
  "hint": "Alt+T new · Alt+←/→ focus · Alt+↑/↓ depth · Alt+Z zoom · Alt+N term · Alt+B browser · Alt+P project · Alt+M macro",
  "tip.add": "Alt+T",
  "tip.fill": "fill to 9 (3×3)",
  "tip.zoom": "Alt+Z",
  "tip.layout": "grid: balanced (square) ⇄ width-fit",
  "tip.macro": "Alt+M — overview all projects on a spiral",
  "tip.send": "Alt+Enter — send a line to another agent's terminal (this / project / all)",
  "send.placeholder": "type an instruction, Enter to send…",
  "send.go": "send",
  "send.this": "this agent",
  "send.project": "project",
  "send.all": "all agents",
  "tip.folder": "open an existing folder/repo as a project",
  "tip.clone": "git clone into a new project",
  "tip.settings": "Settings (agent / permission / deny-list)",
  "tip.perm": "claude permission mode",
  "tip.guard": "deny-list guardrails: write .claude/settings.local.json into each cwd (git-excluded)",
  "agent.pathPlaceholder": "working directory (path or 📁)",
  "agent.pick": "📁",
  "tip.pick": "choose a folder",
  "tip.agentSel": "the CLI agent this window runs",
  "tip.title": "double-click to rename",
  "tip.closeAgent": "close this agent (Alt+X)",
  "tip.layerClose": "close this layer",
  "tip.addTerm": "add terminal",
  "tip.addBrowser": "add browser",
  "toast.noProject": "No project. Create one with folder or clone.",
  "toast.worktree": "worktree: {0}",
  "toast.worktreeFail": "worktree failed: {0}",
  "toast.cloning": "cloning {0} …",
  "toast.cloned": "cloned: {0}",
  "toast.cloneFail": "clone failed: {0}",
  "toast.guardFail": "guard write failed: {0}",
  "toast.guardOn": "guardrails ON — deny-list written (effective after claude restarts)",
  "toast.guardOff": "guardrails OFF — existing files kept",
  "toast.settingsSavedGuard": "Settings saved. Deny-list rewritten (effective after claude restarts).",
  "toast.settingsSaved": "Settings saved",
  "toast.sent": "sent to {0} agent(s)",
  "modal.openTitle": "Open project (folder / repo path)",
  "modal.cloneTitle": "git clone (repository URL)",
  "modal.customTitle": "Custom agent command",
  "modal.ok": "OK",
  "modal.cancel": "Cancel",
  "set.title": "Settings",
  "set.lang": "Language",
  "set.agentCmd": "Agent command",
  "set.perm": "Default permission",
  "set.guardSection": "Guardrail deny-list (your policy)",
  "set.customDeny": "Custom deny (one rule per line)",
  "set.custom": "custom…",
  "set.presets": "Agent presets (one per line: label = command)",
  "guard.pushMain": "Block push to main / master",
  "guard.forcePush": "Block force push",
  "guard.sudo": "Block sudo",
  "guard.net": "Block curl / wget (outbound)",
  "spawn.fail": "[spawn failed: check the directory path]",
};

const ja: Record<string, string> = {
  "btn.add": "＋ エージェント",
  "btn.fill": "⊞ 9体",
  "btn.zoom": "⤢ 拡大",
  "btn.macro": "✦ 俯瞰",
  "btn.send": "↗ 送信",
  "btn.folder": "📁 フォルダ",
  "btn.clone": "⎇ clone",
  "btn.settings": "⚙ 設定",
  "lbl.perm": "perm",
  "unit.agents": "体",
  "unit.proj": "プロジェクト",
  "layout.fit": "幅fit",
  "guard.label": "guard",
  "nest.label": "nest",
  "on": "on",
  "off": "off",
  "tip.nest": "サブエージェント検知：claudeがサブエージェントを起動したら入れ子カードを表示（各worktreeに SubagentStart/Stop フックを設置）",
  "toast.nestOn": "サブエージェント検知 ON — フック設置（再起動した claude から有効）",
  "toast.nestOff": "サブエージェント検知 OFF — フック除去・入れ子カードを消去",
  "subagent.running": "実行中…",
  "empty.title": "プロジェクトを開いて開始",
  "empty.saved": "保存したプロジェクト",
  "saved.rename": "名前変更",
  "saved.remove": "削除",
  "saved.renameTitle": "保存プロジェクトの名前変更",
  "hint": "Alt+T 追加 · Alt+←/→ 移動 · Alt+↑/↓ 奥行き · Alt+Z 拡大 · Alt+N 端末 · Alt+B ブラウザ · Alt+P プロジェクト · Alt+M 俯瞰",
  "tip.add": "Alt+T",
  "tip.fill": "9体（3×3）にする",
  "tip.zoom": "Alt+Z",
  "tip.layout": "グリッド: 個数固定(正方) ⇄ 横幅fit",
  "tip.macro": "Alt+M 全プロジェクトを螺旋で俯瞰",
  "tip.send": "Alt+Enter — 別エージェントの端末へ1行送信（この1体/プロジェクト/全員）",
  "send.placeholder": "指示を入力、Enterで送信…",
  "send.go": "送信",
  "send.this": "この1体",
  "send.project": "プロジェクト",
  "send.all": "全エージェント",
  "tip.folder": "既存フォルダ/リポをプロジェクトとして開く",
  "tip.clone": "git clone して新規プロジェクト",
  "tip.settings": "設定（エージェント・パーミッション・deny-list）",
  "tip.perm": "claude のパーミッションモード",
  "tip.guard": "deny-list ガードレール（各cwdに .claude/settings.local.json を書込・git excludeで非コミット）",
  "agent.pathPlaceholder": "作業ディレクトリ（パス or 📁）",
  "agent.pick": "📁",
  "tip.pick": "フォルダを選択",
  "tip.agentSel": "このウィンドウで動かすエージェント",
  "tip.title": "ダブルクリックで名前変更",
  "tip.closeAgent": "このエージェントを閉じる（Alt+X）",
  "tip.layerClose": "このレイヤーを閉じる",
  "tip.addTerm": "ターミナル追加",
  "tip.addBrowser": "ブラウザ追加",
  "toast.noProject": "プロジェクトがありません。folder か clone で作成してください",
  "toast.worktree": "worktree: {0}",
  "toast.worktreeFail": "worktree作成失敗: {0}",
  "toast.cloning": "cloning {0} …",
  "toast.cloned": "cloned: {0}",
  "toast.cloneFail": "clone失敗: {0}",
  "toast.guardFail": "guard書込失敗: {0}",
  "toast.guardOn": "guardrails ON — deny-list を書込（再起動した claude から有効）",
  "toast.guardOff": "guardrails OFF — 既存ファイルは残します",
  "toast.settingsSavedGuard": "設定を保存。deny-list を再書込（再起動した claude から有効）",
  "toast.settingsSaved": "設定を保存",
  "toast.sent": "{0}体に送信しました",
  "modal.openTitle": "プロジェクトを開く（フォルダ/リポのパス）",
  "modal.cloneTitle": "git clone（リポジトリURL）",
  "modal.customTitle": "カスタムのエージェント起動コマンド",
  "modal.ok": "OK",
  "modal.cancel": "キャンセル",
  "set.title": "設定",
  "set.lang": "言語",
  "set.agentCmd": "エージェント起動コマンド",
  "set.perm": "パーミッション既定",
  "set.guardSection": "ガードレール deny-list（あなたのポリシー）",
  "set.customDeny": "カスタム deny（1行1ルール）",
  "set.custom": "custom…",
  "set.presets": "エージェントのプリセット（1行1件: ラベル = コマンド）",
  "guard.pushMain": "main / master への push を禁止",
  "guard.forcePush": "force push を禁止",
  "guard.sudo": "sudo を禁止",
  "guard.net": "curl / wget を禁止（外部送信）",
  "spawn.fail": "[spawn failed: ディレクトリのパスを確認]",
};

const dicts: Record<Lang, Record<string, string>> = { en, ja };

const detect = (): Lang => {
  const saved = localStorage.getItem("aidt-lang");
  if (saved === "en" || saved === "ja") return saved;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
};

let lang: Lang = detect();

export const getLang = (): Lang => lang;

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem("aidt-lang", l);
  } catch {
    /* ignore */
  }
  applyStatic();
}

/// Translate a key, with optional {0},{1}… positional substitutions.
export function t(key: string, ...args: (string | number)[]): string {
  let s = dicts[lang][key] ?? dicts.en[key] ?? key;
  args.forEach((a, i) => (s = s.replace(`{${i}}`, String(a))));
  return s;
}

/// Apply translations to static markup: [data-i18n]=textContent,
/// [data-i18n-title]=title, [data-i18n-ph]=placeholder.
export function applyStatic(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh!);
  });
}
