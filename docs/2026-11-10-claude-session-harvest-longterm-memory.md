# claude セッション収穫＝長期記憶 設計書（四層記憶の実体化）

作成: 2026-11-10 / ステータス: **スライス1 実装済み（収穫＋耐久保持＋総覧／手入力撤去）。スライス2(蒸留/学習)は未着手** / 前提: `docs/2026-11-08-four-layer-memory-architecture.md`

## 実装メモ（スライス1・2026-11-10）
- Rust `src-tauri/src/claude_sessions.rs`：`claude_sessions(only_cwd)` が全 `*.jsonl` を走査し `SessionDigest` を返す（読み取り専用・寛容パース）。実データ(2678通のセッション)でスタンドアロン検証済み。
- TS `src/claude-sessions.ts`：`claudeSessions()`/`harvestSessions()`(sessionId で upsert)/`persistedSessions()`/`overviewSessions()`（live ∪ 保持。claude側で消えたものに `lostByClaude`）。
- `src/memory.ts`：安定IDの `upsert()` を追加（createdAt保持・updatedAt更新）。
- `src/memory-panel.ts`：**手入力フォーム撤去** → セッション総覧へ全面置換（全/当プロジェクト切替・検索・プロジェクト別グルーピング・`▶ 再開`＝`cd "<cwd>" && claude --resume <id>` をフォーカス端末へ入力・MD/JSON 書出/取込）。
- `src/main.ts`：起動時に `harvestSessions()` を best-effort 実行（自動収穫）。
- 検証：`pnpm build`(tsc+vite) 成功、`pnpm test` 49件通過。Rust フルビルドは GTK 不在の本 cloud では不可 → **実機 `cargo check`/`tauri build` 要**。

## 1. 転換点（これが「長期記憶」の定義）

- **claude 自身のセッション保存は信頼できない**。実際に resume できなくなり、会話が失われた。
  → claude の `~/.claude/projects/.../*.jsonl` は **“壊れうるソース”** としてのみ扱う。
- **手入力で事実を教えるのは長期記憶ではない**（ユーザーは使わない）。`memory-panel` の
  手書き「記憶する」フォームは **撤去 / 最小化**する。
- **長期記憶 = claude の全セッションを自動で吸い上げ → 自分たちの耐久ストアに保持し直し
  → 全体を総覧 → さらに蒸留・学習** したもの。**claude が失っても、こちらには残る。**

これは四層記憶の「個人的無意識（プロジェクト）」「集合的無意識（全体）」を、**手入力ではなく
claude セッションの自動収穫で満たす**、という具体化である。

## 2. データソース（実物で確認済み）

- 位置: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
  （`<encoded-cwd>` は絶対パスの `/`→`-`。ただし復元は不可逆なので**各行の `cwd` フィールドを採用**）
- 各行 = 1 JSON。主なキー: `type`（user/assistant/…）, `message{role,content}`, `cwd`,
  `gitBranch`, `sessionId`, `slug`, `timestamp`, `uuid`。
- `content` は文字列 or ブロック配列（`text` / `tool_result` / …）。
  人間の発話タイトルは「最初の `type:"user"` かつ text ブロックで、`<…>` 由来でないもの」。
  無ければ `slug`（例 `dreamy-hugging-shore`）を使う。
- 1ファイルが数千行・MB級になりうる → **Rust 側でダイジェスト化**し、webview には要約のみ渡す。

## 3. アーキテクチャ（収穫 → 保持 → 総覧 → 蒸留）

```mermaid
flowchart LR
  A[("~/.claude/projects/*/*.jsonl<br/>(壊れうるソース)")] -->|収穫(Rust digest)| B[SessionDigest 群]
  B -->|保持(dedupe by sessionId)| C[("~/.aidt/memory.db<br/>(耐久・正本・書き出し可)")]
  C --> D[総覧UI: 全プロジェクト横断の<br/>セッション履歴（Orca風・モノトーン）]
  C -->|蒸留/学習| E[長期記憶: 決定・規約・頻出文脈]
```

- **収穫 (harvest)**：Rust `claude_sessions(only_cwd)` が全 `*.jsonl` を走査し、
  `SessionDigest{ session_id, cwd, git_branch, slug, title, first_ts, last_ts, messages }`
  を返す（新しい順）。読み取り専用。
- **保持 (persist)**：各ダイジェストを `memory` ストアへ `kind:"summary"`、`tags:["claude-session"]`、
  `sessionId` で重複排除して保存（scope は project 単位＝personal、横断＝collective）。
  **claude が後でセッションを失っても、ここに残る。**
- **総覧 (overview)**：全プロジェクト横断でセッションを一覧（Orca の「Agent セッション履歴」風、
  モノトーン）。プロジェクト／ブランチ／日時／タイトルで俯瞰。
- **蒸留/学習 (distill)**：セッション群から**決定・規約・頻出トピック**を抽出し長期記憶へ。
  → **未決（§5）**。

## 4. 既存UIの扱い

- `memory-panel` の**手入力フォームは撤去/最小化**（長期記憶の入口を「収穫」に一本化）。
- 短期/長期タブ・ロックインなしの書き出し(MD/JSON)・SQLite 正本は**維持**（土台として有効）。

## 5. 未決：蒸留/学習をどうやるか

セッションからの「学習」には要約合成が要る。選択肢：
- **(a) ヒューリスティック（LLM無し）**：頻出トピック、プロジェクト別セッション数、
  最終決定メッセージ等を機械的に集約。安全・即実装可・精度は粗い。
- **(b) claude サブエージェントで要約（LLM）**：収穫したセッションを claude に要約させ、
  決定/規約を長期記憶へ。精度高いがトークン消費・制御が要る（CLAUDE.md のサブエージェント方針に沿う）。

**推奨：まず (a) で「収穫＋耐久保持＋総覧」を出し、(b) は後段**。

## 6. 実装スライス

1. **収穫＋耐久保持＋総覧（まずここ）**：Rust `claude_sessions` ＋ TS 収穫→`memory`保存 ＋
   全プロジェクト横断の総覧UI（モノトーン）。手入力フォーム撤去。
2. **蒸留/学習**：(a)→(b)。
3. **自動化**：起動時/定期にバックグラウンド収穫（新規・更新セッションのみ、mtimeキャッシュ）。

## 7. 注意

- claude の jsonl 形式は将来変わりうる → パースは**寛容に**（欠損キーはスキップ）。
- 大量ファイルの走査は I/O 重め → mtime でキャッシュ、増分収穫（スライス3）。
- Rust 追加は実機 `cargo check` で確認してからリリース。
