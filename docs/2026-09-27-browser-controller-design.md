# ブラウザレイヤー刷新 設計書 — iframe → CDP駆動Chromium（ADE風ブラウザ操作）

作成: 2026-09-27 / ステータス: **提案（未着手）** / 別トラック（vim調査とは独立）

## 1. 背景・目的

現在の browser レイヤーは **WKWebView 内の `<iframe>`**。これは表示専用で、次の制約がある：

- `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` を送るサイトは**埋め込み拒否**（Google 等の主要サイトが該当）。
- クロスオリジンの **DOM を読めない**（`iframe.contentDocument` が同一オリジン以外 null）。
- **CDP（Chrome DevTools Protocol）が無い** ため、要素検査も自動操作もできない。

Orca などの **ADE（Agent Development Environment）** は、実ブラウザ（Chromium）を **CDP/Playwright で駆動**し、DOM/アクセシビリティツリーを AI に渡して「**要素単位で AI が操作**」できる。本ツールも同思想（多エージェント並列・俯瞰）なので、ブラウザも「見るだけ」から「**AI が触れる**」へ引き上げる。

### ゴール
1. 任意サイトを表示（X-Frame-Options に妨げられない）。
2. **要素検査**：DOM / アクセシビリティ(AX)ツリーを取得。
3. **AI 操作**：AI が指定した要素へ click / type / scroll / select を実行。
4. 既存の 2 階層モデル（Project→Agent→Layer）に自然に載せる。
5. **人間が主導**する設計哲学を維持（破壊的操作は確認を挟む）。

## 2. 非ゴール（今回やらない）
- 独自ブラウザエンジンの実装。
- Electron への全面移行（Tauri は維持）。
- 既存 iframe レイヤーの即時廃止（当面は併存 → 段階移行）。

## 3. 技術選択肢

| 案 | 内容 | 要素検査/AI操作 | 一貫性(mac/win/linux) | コスト | 判定 |
|---|---|---|---|---|---|
| A | 現状 iframe (WKWebView) | ✗ | ○ | - | 現状。制約大 |
| B | Tauri標準WebViewを別窓 | ✗(mac=WebKitはCDP無) | ✗ | 中 | 不採用 |
| C | **Chromiumを子プロセス起動＋CDP/Playwright制御** | ◎ | ○(Chromium同梱/検出) | 中〜大 | **採用** |
| D | win=WebView2 / mac=WKWebView 混在 | △ | ✗ | 大 | 不採用 |
| E | Electron移行 | ◎ | ○ | 特大 | 今回不採用 |

→ **案 C** を採用。表示方式は段階導入（下記）。

## 4. アーキテクチャ

```
[UI(WKWebView)]  browser layer (canvas / <img>)
       │  ユーザー操作(クリック/キー)、AIアクション
       ▼
[TS] browser-controller.ts  ── invoke ──►  [Rust] browser.rs
       ▲  AXツリー/スクショ/フレーム            │  Chromium起動・CDP接続
       │                                        ▼
       └───────── screencast frames ◄──── [Chromium] (Playwright/CDP)
```

- **表示方式（2段階）**
  - **C1（PoC・別ウィンドウ）**: headed Chromium を別 OS ウィンドウで表示。実装容易。まず“AI が要素を触れる”価値を最短で確認する。
  - **C2（本命・埋め込み）**: CDP `Page.startScreencast` で JPEG フレームを取得 → レイヤーの `<canvas>` に描画。入力は座標/キーを `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` で Chromium に転送。真の“アプリ内埋め込み”。

- **AI 連携**
  - 取得: **AX ツリー（role + name + ref）** を第一候補（座標非依存で堅い・トークン軽い）。補助的に DOM スナップショット。Playwright の `ariaSnapshot` / `locator` が使える。
  - 実行: AI が返す `{ action, ref|selector, value }` を Playwright/CDP で実行。
  - 安全: 送信・購入・削除など**破壊的操作は人間確認**を挟む。自動操作は**既定オフ**、明示的にオンで。（既存の「人が駆動」哲学の踏襲。CLAUDE.md の cross-agent messaging 方針と整合）

## 5. モジュール設計（責務境界）

| 追加/変更 | 責務 |
|---|---|
| `src/browser-controller.ts`（新規・純ロジック中心） | レイヤー↔コントローラAPI、AXツリー整形、アクション発行、状態管理 |
| `src-tauri/src/browser.rs`（新規） | Chromium 起動/検出、CDP 接続、screencast 中継、`Input.*` 転送 |
| `src/agent.ts` | browser layer factory を拡張（`kind: "browser"` の中身を iframe→controller 版へ切替可能に） |
| `src/app.ts` | **触らない**（機能追加は新モジュールへ＝CLAUDE.md ルール順守） |

- 依存: この環境には **Chromium + Playwright が同梱**（`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`）。配布時は「Chromium 同梱」か「ユーザーの Chrome/Chromium 検出」を選択。

## 6. データフロー（AI が要素を操作する1サイクル）
1. `controller.getAXTree()` → Rust/CDP で AX ツリー取得 → 整形して AI に提示。
2. AI が `{action:"click", ref:"button#submit の ref"}` を返す。
3. `controller.act(action)` → CDP `Input.*` / Playwright `locator.click()` 実行。
4. 変化を screencast フレーム＋新 AX ツリーで反映。

## 7. 段階計画（PoC → 製品）
1. **PoC**: `browser.rs` で別窓 Chromium を起動し URL 表示＋AX ツリーを取得して console/UI に dump（C1）。
2. **AI 操作(手動トリガ)**: AX ツリーを AI に渡し、返ってきた click/type を実行。
3. **埋め込み**: `startScreencast` → canvas 描画＋入力転送（C2）。
4. **統合**: レイヤー種別に新ブラウザを追加、Z スタック/優先度/永続化に載せる。iframe は fallback として当面併存。
5. **配布**: Chromium 同梱 or 検出、mac/win/linux で確認、未署名の注意書き。

## 8. リスク・未確定事項
- **配布サイズ**: Chromium 同梱は +150MB 級。→ 「同梱」か「既存 Chrome 検出」かは別途判断。
- **screencast の遅延/画質/IME/高DPI**: 体感品質に直結。C1 で価値検証してから C2 に投資。
- **WKWebView × canvas 合成**: vim 描画バグ（`docs/2026-07-15-vim-debugging-journey.md`）の教訓。フレームを canvas に流す負荷/合成を PoC で計測。
- **セキュリティ**: 任意サイトの自動操作はガードレール必須（破壊的操作の確認、対象ドメイン許可制など）。
- **認証**: ログインが要るサイト。プロファイル永続化の可否。

## 9. テスト戦略
- **headless で自動テスト可能**（terminal-guards と同方針）: AX ツリー整形・アクション発行・controller の状態遷移は純ロジックとして vitest でカバー。Playwright 制御はこの環境で実行可能。
- **実機のみ**: screencast の canvas 描画・入力転送の体感（WKWebView 依存）。

## 10. 参考
- Orca（ADE）: https://www.onorca.dev/ , https://github.com/stablyai/orca
- Chrome DevTools Protocol / Playwright（CDP: `Page.startScreencast`, `Input.dispatchMouseEvent`, accessibility snapshot）
