# AI Dev Terminal MAX

[English](./README.md) ・ 日本語

複数の Claude Code を**並列**で動かし、全エージェントを**一画面で俯瞰**できるネイティブ・ターミナル多重化アプリ（macOS / Tauri）。tmux・zellij と違い、(1) たくさんのエージェントを格子状に総覧でき、(2) 各エージェントは Z 軸の「奥行きスタック」を持ち、claude のターミナルの背後にブラウザや追加ターミナルを縦に格納でき、(3) **Project（リポジトリ）→ Agent（git worktree）→ Layer（奥行き）** の2階層モデルで、1リポを複数エージェントが隔離ブランチで並列に触れる。

> ⚠️ ステータス: **MVP / 一部未検証**。ブラウザレイヤーは iframe ベースで、X-Frame-Options で埋め込み拒否するサイトは表示できない（既知の制約）。

## スタック

| 層 | 技術 | 役割 |
|---|---|---|
| バックエンド | Rust + [Tauri 2](https://tauri.app) | ウィンドウ・IPC・PTY・git |
| PTY | [`portable-pty`](https://crates.io/crates/portable-pty) | 各ペインで実プロセス(claude/shell)を擬似端末で起動 |
| 描画 | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) + WebGL addon | GPU 加速ターミナル描画 |
| UI | Vanilla TS（フレームワークなし） | 俯瞰グリッド / 奥行き / マクロ螺旋 |

PTY 出力は Rust→TS へ per-session の Tauri `Channel`(base64)でストリーム。

## 概念（2階層モデル）

- **Project** = 1リポジトリ/フォルダ。プロジェクト帯のタブ。
- **Agent** = そのリポの **git worktree**（隔離ブランチ `feature/yyyymmdd-N`）。俯瞰グリッドの1カード。
- **Layer** = エージェント内の Z 軸スタック（`terminal` / `browser`）。前面1枚＋背後がデッキ状に重なる。
- **Overview / Zoom** = 全エージェントを格子表示 / フォーカス中を全画面。
- **Macro** = 全プロジェクトを黄金角螺旋（フィロタキシス）で俯瞰。

**プロジェクトの切替**：グリッドには一度に1プロジェクトのエージェントだけが表示されます。上部の帯にあるタブが開いているプロジェクトで、クリックか `Alt+P` で巡回します。**1プロジェクトしか無いと `Alt+P` は何も起きません**（切替先が無いため）。**📁 プロジェクトを開く** / **⎇ clone** で別プロジェクトを追加してから使ってください。**✦ macro** で全プロジェクトを一覧できます。

**「メイン並列」「サブエージェント」「プロジェクト」の3つの軸**（別物です）：
- **メインエージェントの並列** → 1プロジェクト内に agent（worktree）を増やす（`+ agent` / `⊞ fill`）。グリッドに横並びで同時稼働（各々が1個のメイン：claude/codex/…）。
- **サブエージェント** → claude が Task を使うと自動生成。そのウィンドウのZスタックに **🪆入れ子カード**で表示（**nest** ON）。別ウィンドウではない。
- **プロジェクト** → 別リポ/フォルダ。`Alt+P` / タブ / macro でセットごと切替。

つまり「並列表示」＝*今の*プロジェクトの*メイン*エージェントを同時表示、「プロジェクト切替」＝*別リポ*のエージェント群へ移動、です。

## 開発

```bash
pnpm install
pnpm tauri dev      # 開発ウィンドウ起動
pnpm tauri build    # .app / .dmg バンドル
```

要件: Node, Rust/cargo, pnpm, git（macOS。Tauri 前提条件: https://tauri.app/start/prerequisites/ ）

## キーボード（leader = Alt / Option）

| キー | 動作 |
|---|---|
| `Alt+T` | 新規エージェント（git リポなら worktree 生成） |
| `Alt+←/→`（`Alt+H/L`）| エージェント間フォーカス移動 |
| `Alt+↑/↓`（`Alt+K/J`）| 奥行きレイヤーを巡回 |
| `Alt+Z` | 俯瞰 ⇄ 集中 トグル |
| `Alt+P` | 次のプロジェクトへ切替 |
| `Alt+M` | マクロ俯瞰（黄金螺旋）⇄ 通常 |
| `Alt+1`〜`9` | 番号でエージェントへジャンプ＋集中 |
| `Alt+N` / `Alt+B` | ターミナル / ブラウザ レイヤー追加 |
| `Alt+W` / `Alt+X` | レイヤーを閉じる / エージェントを閉じる |

マウス: カードをクリックでフォーカス、ダブルクリックで集中。ヘッダのドットでレイヤー切替。タイトルはダブルクリックで改名（cwd 名から自動命名、改名後は固定）。📁 でフォルダ選択、パス欄に直接入力も可。

## ツールバー

- **📁 folder / ⎇ clone**: 既存フォルダを開く / `git clone` でプロジェクト作成。
- **⊞ fill 9**: アクティブプロジェクトに 9 体（git なら 9 worktree）。
- **▦ 3×3 / fit**: 個数固定の正方グリッド ⇄ 横幅fit。
- **perm**: パーミッションモード（`auto` / `normal` / `bypass ⚠`）。既定 `auto`。起動しない場合は `normal`。
- **🛡 guard**: deny-list を各 cwd の `.claude/settings.local.json` に書込（`.git/info/exclude` で非コミット）。内容は **⚙ 設定**で構成。
- **⚙ 設定**: エージェント起動コマンド・パーミッション既定・deny-list（プリセット＋カスタム行）。
- **✦ macro**: マクロ螺旋ビュー。

## 永続化と再開（resume）

- **ワークスペース自動保存・復元**：プロジェクト/エージェント/cwd（パス）/タイトル/レイヤー/レイアウト/perm/guard/nest/プリセットを localStorage に自動保存し、起動時に復元。**閉じて開いてもパス・レイアウトはそのまま**。
- **保存プロジェクト（セーブデータ式）**（`aidt-projects`）：開いたフォルダ/cloneしたリポは**ラベル＋パス**で保存され、空状態の一覧から再オープン（✎で改名・×で削除）。
- **会話の再開（resume）**：エージェントは `claude --continue` で起動するため、**ウィンドウを閉じて再度開く（再spawn）とそのworktreeの直近の会話を再開**します（無ければ自動で新規）。`×`／`Alt+X` で閉じて、後で開けば続きから。resumeは**ディレクトリ単位**で、worktreeごとに別スレッドを保持します。（claude以外のエージェントはそのまま起動）

## 構成

`CLAUDE.md` のモジュールマップ参照。`src/app.ts`（状態・ライフサイクル）/ `render.ts`（描画）/ `persistence.ts`（保存）/ `agent.ts`・`project.ts`（モデル）/ `guard.ts`（deny-list プリセット）/ `ui.ts`（モーダル等）、`src-tauri/src/pty.rs`・`git.rs`。

## 既知の制約

- ブラウザレイヤーは iframe（X-Frame-Options 不可）。ネイティブ子 WebView 化の余地あり。
- `auto` パーミッションはアカウント/モデル依存（Opus/Sonnet 4.6+）。
- guard は再起動した claude から有効。

## ライセンス

[MIT](./LICENSE)
