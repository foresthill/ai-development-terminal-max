// Claude Code command palette: the 15 slash commands (grouped BUILD / CONTEXT /
// CONTINUE), one click away. Clicking a command TYPES it into the focused agent's
// terminal WITHOUT submitting — the person reviews and presses Enter. This is the
// human-driven injection the app already uses for memory recall; no autonomous
// agent control (see CLAUDE.md). Own module so app.ts doesn't grow.
//
// This is a curated starter set (from the community "15 Claude Code commands"
// reference); the actual commands available in a given Claude Code session can
// differ — run `/help` in the terminal to see the live list.
import { toast } from "./ui";
import { t, getLang } from "./i18n";

export interface CommandPaletteCtx {
  /** Type text into the focused agent's terminal (no auto-submit). Returns false
   *  when there is no terminal to type to. */
  sendToAgent: (text: string) => boolean;
}

interface Cmd {
  cmd: string;
  en: string;
  ja: string;
}

const GROUPS: { title: string; cmds: Cmd[] }[] = [
  {
    title: "BUILD",
    cmds: [
      { cmd: "/goal", en: "Set a measurable goal", ja: "測れるゴールを設定" },
      { cmd: "/batch", en: "Migrate in parallel", ja: "並列で一括処理" },
      { cmd: "/subtask", en: "Delegate with context", ja: "文脈付きで委譲" },
      { cmd: "/deep-research", en: "Research with citations", ja: "出典付きで調査" },
      { cmd: "/design", en: "Create editable artboards", ja: "編集可能なデザイン作成" },
    ],
  },
  {
    title: "CONTEXT",
    cmds: [
      { cmd: "/plan", en: "Plan before changing code", ja: "変更前に計画" },
      { cmd: "/memory", en: "Keep project knowledge", ja: "プロジェクト知識を保持" },
      { cmd: "/compact", en: "Summarize the context", ja: "文脈を要約（圧縮）" },
      { cmd: "/branch", en: "Branch the conversation", ja: "会話を分岐" },
      { cmd: "/rewind", en: "Restore a checkpoint", ja: "チェックポイントへ巻き戻し" },
    ],
  },
  {
    title: "CONTINUE",
    cmds: [
      { cmd: "/mcp", en: "Manage connected tools", ja: "接続ツールを管理" },
      { cmd: "/loop", en: "Repeat a local check", ja: "ローカル確認を繰り返す" },
      { cmd: "/schedule", en: "Schedule cloud tasks", ja: "クラウドのタスクを予約" },
      { cmd: "/simplify", en: "Clean up the code", ja: "コードを整理" },
      { cmd: "/remote-control", en: "Continue on your phone", ja: "スマホで続きを操作" },
    ],
  },
];

export function openCommandPalette(ctx: CommandPaletteCtx): void {
  const ja = getLang() === "ja";
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal modal-wide modal-cmd";
  box.innerHTML = `
    <div class="modal-title">${t("cmd.title")}</div>
    <div class="set-hint">${t("cmd.hint")}</div>
    <div class="cmd-cols">
      ${GROUPS.map(
        (g) => `
        <div class="cmd-col">
          <div class="cmd-group">${g.title}</div>
          ${g.cmds
            .map(
              (c) => `
            <button class="cmd-item" data-cmd="${c.cmd}">
              <span class="cmd-name">${c.cmd}</span>
              <span class="cmd-desc">${ja ? c.ja : c.en}</span>
            </button>`,
            )
            .join("")}
        </div>`,
      ).join("")}
    </div>
    <div class="modal-row"><button id="cmd-close" class="primary">${t("modal.ok")}</button></div>`;
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

  for (const b of Array.from(box.querySelectorAll<HTMLButtonElement>(".cmd-item"))) {
    b.addEventListener("click", () => {
      const cmd = b.dataset.cmd ?? "";
      if (ctx.sendToAgent(cmd)) {
        toast(t("cmd.sent", cmd));
        close();
      } else {
        toast(t("cmd.noAgent"), "error");
      }
    });
  }
  box.querySelector("#cmd-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
}
