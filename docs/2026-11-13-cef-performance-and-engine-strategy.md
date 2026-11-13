# CEF: performance, per-platform engine strategy, and revert plan

作成: 2026-11-13 / 対象: macOS を CEF(Chromium) 化した版（`feature/cef-mac`）の運用ノウハウ。
関連: `docs/2026-11-12-cef-migration-plan.md`、`CLAUDE.md` の vim 節。

このノートは「CEF にして重くならないか」「将来 macOS 側を wry に戻すべきか」「Windows/Linux を
分けている判断」の記録。digital garden にも持ち出しやすいよう、結論→理由→運用の順でまとめる。

## 1. 重くなる？ ウィンドウを増やすと有意に悪化する？

**結論**：**固定コスト（起動時のベースライン）は増える**が、**ウィンドウを増やしたときの“1枚あたりの増え方”は
ほぼ変わらない**。10枚以上開いても「CEF だから」の追加分は基本一定。

### なぜか（アーキテクチャ）
- このアプリは **1つの Tauri ウィンドウ＝1つの webview**。各エージェント「ウィンドウ/レイヤー」は
  その中の **DOM要素（xterm インスタンス）** で、**ウィンドウごとに別ブラウザを立てていない**。
- WKWebView → CEF の違いは**エンジンの実体**だけ：
  - WKWebView：WebKit のプロセス群（OS 共有、軽い）。
  - CEF：Chromium を**同梱**。1 webview でも browser / GPU / renderer / network / utility の
    **数個のプロセス**が常駐。これが**起動時の固定オーバーヘッド**（RAM 概ね +数百MB、配布サイズ +~170MB）。
- **10枚開いたときに効くのは別の要因**：各ウィンドウの
  - xterm のスクロールバック＆WebGL コンテキスト（描画）
  - **PTY が起動する実プロセス**（`claude` = node など。1体で数百MB級）
  これらは**エンジンに依存しない**。10体なら node 10個が支配的で、CEF か WKWebView かはほぼ無関係。
- したがって **CEF の相対的な重さは、ウィンドウが増えるほど“薄まる”**（分母＝エージェント群が大きくなるため）。

### 実測の勧め（憶測で語らない）
数字は実機差が大きいので、Activity Monitor で **1枚 vs 10枚**の
「メモリ（アプリ＋子プロセス合計）」「CPU%」を取るのが確実。観点：
- アプリ本体＋`*Helper (Renderer/GPU/…)` の合計（＝webview エンジン分）。
- `claude`/`node` 等エージェント子プロセスの合計（＝エンジン非依存の本体負荷）。
- GPU メモリ：ターミナルは WebGL で描く（`@xterm/addon-webgl`）。**WebGL コンテキストはブラウザ側に
  同時数の上限**（概ね16前後）があり、多数ウィンドウで古い context が失効し得る。これはエンジン問わずの
  論点だが Chromium の方が素直に扱える。多すぎる場合は一部を DOM レンダラにフォールバックする手もある。

### まとめの目安
- 体感：**起動直後は CEF 版の方が重い**（Chromium ベースライン）。
- 多数ウィンドウ運用：**増分はほぼ同じ**。「10枚で急に悪化」は主にエージェント子プロセス起因で、CEF 固有では
  ない見込み。**要実測**。

## 2. 将来 macOS 側を wry に戻す（macOS 27 等で WKWebView が直ったら）

**方針**：戻せるように**作りは既に分離済み**。macOS だけ CEF、Windows/Linux は wry。
`src-tauri/Cargo.toml`（per-target deps）／`src-tauri/src/main.rs`・`lib.rs`（`#[cfg(target_os=...)]`）で
ランタイムを出し分けている。**戻す＝この cfg を wry に倒し、CEF 依存を外すだけ**の局所変更。

### 戻す条件（トリガー）
- **wry#1848 が修正**され、**macOS の RELEASE ビルドで**全画面 TUI（vim/htop/less）が正しく再描画される
  ことを確認できたら。※必ず `pnpm tauri build` の**リリースビルドで検証**（dev では元々再現しない）。
- macOS 27 が出ても**自動で直るとは限らない**。「OSが上がったら戻す」ではなく
  「**wry#1848 の修正が入り、実機リリースで描画OKを確認できたら戻す**」を条件にする。

### 戻しやすくする任意の改善（今は任意）
- 現状は OS で固定分岐。将来を見据えるなら **Cargo feature `cef`** でエンジン選択に抽象化すると、
  コード変更なしに macOS を wry/CEF どちらでもビルドできる（例：`default = macos で cef on`、
  戻すときは feature を外すだけ／両方のビルドを並行検証できる）。**過剰最適化は不要**——今の cfg 分岐で十分で、
  必要になったら feature 化。
- **DOM エディタ（Alt+E）は engine に関係なく残す**（フォールバック兼・軽量編集）。

### 追跡
- `CLAUDE.md` の vim 節に「CEF が正」の現状を記載済み。戻すときは同節と本ノート、移行計画 doc を更新。
- Watch: https://github.com/tauri-apps/wry/issues/1848

## 3. Windows/Linux を CEF にしない判断（記録）
- **wry#1848 は WKWebView 固有**。Windows(WebView2)/Linux(WebKitGTK) では再現しない＝CEF 不要。
- CEF を全OSに入れると**無駄に +170MB・+プロセス**。なので **macOS だけ CEF、他は wry** が最小コスト。
- ※ただし **Tauri 3 化自体は全OS共通**（`tauri` crate のメジャーが 3）。つまり Windows/Linux も
  「Tauri 3 + wry」に移行済み。CI で緑を確認済み（下記）。

## 4. CI/リリースで踏んだ罠（プレリリース検証の記録）
- **stale `Cargo.lock` 罠**：`Cargo.toml`/npm を Tauri 3 にしても **`Cargo.lock` を再生成・コミットしていないと**
  CI で `tauri (v2.x) : @tauri-apps/api (v3-alpha)` の不一致で**ビルド前に即死**。ローカルは cargo が lock を
  自動再生成するので気づきにくい。→ `cargo generate-lockfile` して**コミット**（`cargo check --locked` で確認）。
- **tauri-action@v0 は Tauri 3-alpha を駆動できる**（v0.3.0-cef.2 で Windows/Linux が緑）。懸案だったが解消。
- **macOS ジョブ2本同時はこのアカウントで不可**：`macos-14` が t=0 cancel、`macos-13` が runner 割当されず
  starve。過去は単一 `macos-latest` で成功していた。→ **macOS は arm64 単独ジョブ**に（CEF は universal 不可の
  ため元々アーキ別）。Intel macOS は将来**直列ジョブ**で追加候補。
- **CEF ビルド固有の要件**：macOS に `cmake`+`ninja`（libcef_dll_wrapper のビルド）、CEF ~1GB を
  `~/Library/Caches/tauri-cef` にキャッシュ。署名/公証（Chromium helper 群）とランナーのディスクは
  arm64 本ビルドで要確認。

## 5. digital garden 持ち出し用・一言サマリ
- CEF は「**起動時の固定費が増える**が、**ウィンドウ数に対する増分は変わらない**」。多数運用の重さは
  **エージェント子プロセス**が主因でエンジン非依存。→ まず実測。
- macOS だけ CEF、他は wry。**戻す条件は「OSが上がったら」ではなく「wry#1848 がリリースビルドで直ったら」**。
- 新エンジン/新メジャーは **lockfile を必ず再生成コミット**。CI の macOS 並列はアカウント上限に注意。
