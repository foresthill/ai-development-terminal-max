# macOS 26 (Tahoe) で vim 等の全画面TUIが固まる問題 — 原因と対策

*2026-10-24 / ai-development-terminal-max 調査レポート*

## 要約（TL;DR）

- **症状**: 配布ビルド（`tauri build`）で vim を開くと**画面が最初のフレームのまま固まり、編集内容が見えない**。`tauri dev` では正常。
- **原因**: **macOS 26 (Tahoe) / Apple Silicon の WKWebView のコンポジタ（描画合成）リグレッション**。
  DOM は更新されるのに WKWebView が**新フレームを画面に提示(present)しなくなる**。アプリのコードのバグではない。
  上流 issue: [tauri-apps/wry#1848](https://github.com/tauri-apps/wry/issues/1848)（未修正）。
- **試した対策（＝効かなかった）**: alt-screen を無効化して通常画面で描かせたが、**実機で `type=normal`＋DOMは埋まっているのに画面は固まったまま**。macOS 26 は代替/通常どちらのバッファでも「全画面の一括書き換え」を提示しない。→ **2026-10-25 に無効化（no-op化）**。
- **本当の解決策（予定）**: **DOMベースのエディタ・レイヤー**を追加する（通常HTMLは再描画されるので凍らない）。vim等の端末はWindows/Linux/旧macOSでは従来どおり動く。
- **範囲**: このバグは **macOS 26（Tahoe）/ Apple Silicon の release 限定**。Windows/Linux/旧macOS は無縁。

## 環境（再現条件）

| 項目 | 値 |
|---|---|
| 機種 | MacBook Pro 14" (2023), Apple **M3 Pro** (arm64) |
| OS | **macOS Tahoe 26.6.2** |
| ビルド | **release**（`pnpm tauri build`）※ `tauri dev` では再現しない |
| wry / tauri | **0.55.1 / 2.11.2**（上流報告の 0.55.1 / 2.11.5 とほぼ同一） |

## どう切り分けたか（事実の積み上げ）

1. **表示だけが壊れている**を確定：
   - `Alt+Shift+D`（バッファ/DOMダンプ）で **`DOM rows=27 nonEmpty=27`、`DOM 0|HELLO`** ＝ DOM は最新。
   - しかし画面は空の vim（`"test.txt" [New]`）のまま＝**ピクセルだけ古い**。
   - `cat test.txt` → **`HELLO`** ＝ 入力も vim も保存も全部正常。**壊れているのは画面の再描画のみ**。
2. **我々の実装が原因ではない**を確定（すべて release で再現）：
   - DOM レンダラでも **WebGL レンダラ**でも固まる。
   - レイヤー**1枚**でも固まる（デッキ合成も無関係）。
   - **ウィンドウをリサイズ**しても戻らない。
   - `devtools` 機能を有効にした release でも固まる（Inspector 説は否定）。
3. **通常画面は正常**を確定：
   - `for i in 1 2 3 4 5; do printf "\rcount: $i"; sleep 1; done` が **1→5 とアニメーションして見える**。
   - ＝ alt-screen（全画面アプリ）だけが固まる。
4. **上流に一致**：wry#1848 が「macOS 26 / Apple Silicon / release で、DOM と a11yツリーは生きたまま WKWebView が新フレームを提示しない」と報告。症状・OS・バージョンが一致。

## 根本原因

macOS 26 の WebKit/WKWebView の**コンポジタが、alt-screen 領域の再ラスタライズ/フレーム提示を停止する**リグレッション。
`backdrop-filter: blur()` や transform/opacity アニメ等の「レイヤーchurn」が誘発要因として報告されている。
**上流に修正はまだ無い**（issue 未解決）。

## 対策（この実装）

全画面TUIが使う **alt-screen 切替（DECSET/DECRST 47 / 1047 / 1049）を端末側で握りつぶす**。
これにより vim/less/htop/man/tmux 等が**通常画面（スクロールするバッファ）で描画**され、通常画面は正常に
再描画されるため、表示・編集・操作ができるようになる（vim の `set t_ti= t_te=` と同等の効果を端末レベルで）。

- 実装: `src/terminal-guards.ts` の `registerCsiGuards`（`setDisableAltScreen(true)` 時のみ alt-screen を握りつぶす）。
- トレードオフ: **TUI終了後も出力がスクロールバックに残る**（元画面に復帰しない）。表示が多少雑多になることがある。
- 既存の入力側対策（カーソルレポートのループ `\e[?6n` 握りつぶし）はそのまま有効。

## 影響範囲（なぜ全ユーザーに常時適用しないか）

常時適用するとバグの無い環境まで alt-screen が劣化するため、**影響のあるホストだけ**に限定：

| 環境 | WebView | このバグ | alt-screen 対策 |
|---|---|---|---|
| **macOS 26 (release)** | WKWebView | **あり** | **有効化（握りつぶす）** |
| macOS 26 (`tauri dev`) | WKWebView(debug) | 出ない | 無効（従来どおり） |
| macOS < 26 | WKWebView | 報告なし | 無効（従来どおり） |
| Linux | WebKitGTK | 別エンジン・無縁 | 無効（従来どおり） |
| Windows | WebView2 (Chromium) | 別エンジン・無縁 | 無効（従来どおり） |

判定は Rust 側 `sys::alt_screen_broken`（`cfg(all(target_os="macos", not(debug_assertions)))` かつ `sw_vers` の
メジャー ≥ 26）で行い、`src/main.ts` が起動時に一度呼んで**端末生成前に**フラグを立てる。UA は偽装している
ため、OS判定はフロントの `navigator` ではなく Rust で行う。

## 恒久対応の候補（将来）

1. **上流修正待ち**：macOS/WebKit 側、または wry/tauri の新版で #1848 が直れば、この対策は不要（フラグを戻すだけ）。
2. **ネイティブ描画**：WKWebView を介さない端末描画（最も確実だが大工事）。
3. 必要なら **Settings で alt-screen 対策のオン/オフ**を手動切替できるようにする。

## 参考

- [tauri-apps/wry#1848 — WKWebView stops presenting frames (stale/partial frames)](https://github.com/tauri-apps/wry/issues/1848)
- 詳細な調査の時系列: `docs/2026-07-15-vim-debugging-journey.md`
- 関連コード: `src/terminal-guards.ts` / `src/main.ts` / `src-tauri/src/sys.rs`

---

## 2026-10-25 追記：alt-screen 無効化は「効かなかった」ので撤回

実機検証の結果、**この対策では直らない**と判明した：
- alt-screen を無効化 → vim は通常バッファで描画されるようになった（`Alt+Shift+D` の `type=normal` で確認）。
- しかし **DOM は埋まっている（`DOM rows=27 nonEmpty=26`）のに、画面は依然として固まったまま**。
- ＝ macOS 26 の WKWebView は、**代替画面でも通常画面でも「全画面の一括書き換え」を提示しない**。alt-screen かどうかは本質ではなかった。唯一提示されるのは「1行スクロール/追記」（`printf '\rcount'` やシェル出力）のような、動く/増える領域だけ。

**対応**：`sys::alt_screen_broken` を **`false` 固定（no-op）**にして撤回（残骸が出るだけで無益だったため）。握りつぶしコードは履歴として残置。

**結論**：macOS 26 では **webview 内の端末で全画面TUIを表示するのは不可**。編集用途は **DOMベースのエディタ・レイヤー**（通常HTMLなので再描画される）で解決する方針に切替。vim等の端末は Windows/Linux/旧macOS では従来どおり動く。
