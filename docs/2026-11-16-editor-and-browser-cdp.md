# エディタの格上げ & ブラウザ内蔵（方式A / CDP駆動）設計メモ

作成: 2026-11-16 / ステータス: エディタ=実装済み（`feature/editor-upgrades`）、ブラウザ=**核を検証済み**（`spike/browser-cdp`）、C1実装はこれから

v0.3.0（CEF採用）出荷後の次トラック。2つの「重いGUIを常駐アプリで置き換える」話。

---

## 1. エディタ層の格上げ（実装済み）

### 背景

`src/editor.ts` の CodeMirror 6 エディタ層は、元々 macOS 26 で vim が描画できない
（WKWebView コンポジタバグ wry#1848）ための回避策だった。CEF 採用で vim もターミナルで
描画できるようになったので、エディタ層は「macOS 専用の代替」ではなく **全 OS で使える
普通の GUI 編集手段** に位置づけが変わった。

さらに重要な価値: **VSCode を起動するのが重い**という不満への答え。アプリは既に常駐
しているので、ここでファイルを開くのは一瞬。外部エディタのコールドスタートが要らない。

### 入れた機能

- **Alt/Option+クリックで内蔵エディタに開く** — ターミナルのパスリンクに `edit` モードを
  追加（既存の `open`=OS標準アプリ / `reveal`=親フォルダ と並ぶ3モード）。⌘/Ctrl の挙動は不変。
- **ツールバー拡張** — ファイル名（dirty時 ●）＋ 行:列 ＋ 言語セレクト（auto＋手動）＋
  vim トグル ＋ Open ＋ Save。
- **vim キーバインド** — `@replit/codemirror-vim`（CodeMirror 6公式のvim拡張。`@codemirror/vim`
  は存在しないので注意）。opt-in＋localStorage永続（既定OFF＝ツールを中立に保つ）。
  undo/redo は `⌘Z`/`⌘⇧Z`、vim時は `u`/`Ctrl-r` の両方で効く。`Compartment` でライブ切替。
- **言語も Compartment** 化し、セレクト変更でビュー再構築なしに再設定。

実装の要点: `addEditorLayer(agent, path?)` が明示パスを取れるように（ピッカーをスキップ）。
app.ts 側は既存のパスリンク/エディタ配線の拡張のみ（新規concernは作らない＝CLAUDE.mdルール）。

### 今後やれること

- 行ジャンプ（`file.ts:42` クリックで42行目へ）。
- テーマ/言語パックの追加。
- 本格的なプラグイン機構（任意拡張のマーケット）は大規模なので別途。

---

## 2. ブラウザ内蔵（方式A = ユーザーのChrome検出＋CDP駆動）

### なぜ方式A

現状の browser 層は iframe（表示専用・X-Frame-Options で主要サイト埋め込み拒否・CDPなし）。
`docs/2026-09-27-browser-controller-design.md` の案C（Chromium を CDP/Playwright で駆動）を、
**配布サイズ0** で始められる「ユーザーの Chrome/Chromium 検出」版（方式A）で着手する。

| 方式 | 追加サイズ | 備考 |
|---|---|---|
| A. ユーザーのChrome検出 | **ほぼ0** | Chrome未導入だと使えない。C1の既定 |
| B. Chromium同梱 | +約150MB/OS | macOSはCEFの170MBに上乗せ＝500MB級 |
| C. 既存CEFをCDP流用 | ほぼ0 | 技術的に最エレガントだが前例少。後回し |

**メモリ**: CDP駆動Chromiumは CEF とは別プロセス群。ブラウザ層1枚ごとに1 Chromiumを立てる
素直な実装だと「10枚以上」でRAMを食う。→ **1 Chromiumを共有し複数 page/context で開く**設計を
最初から入れる（プロセス1本でタブを増やす）。

### 段階

- **C1（別ウィンドウPoC・次の実装）**: headed Chrome を別OSウィンドウで起動し、CDPで
  navigate / ariaSnapshot / click・type。「AIが要素を触れる」価値を最短で確認。
- **C2（本命・埋め込み）**: CDP `Page.startScreencast` のフレームをレイヤーの `<canvas>` に
  描画、入力を `Input.*` で転送。真のアプリ内埋め込み。

### 核の検証（`spike/browser-cdp` — 済み）

CEF の時に `spike/cef` でエンジンを先に証明したのと同じく、Tauriビルド前に方式Aの核を
サンドボックスのPlaywright/Chromiumで通した（`node spike/browser-cdp/cdp-spike.cjs`）:

```
detectChrome() → 外部Chrome起動(--remote-debugging-port) → connectOverCDP: attached ✓
navigated ✓ / AX(ariaSnapshot): heading "Hello" / textbox "name field" / button "Submit"
action: fill("Ada") + click("Submit") → #out = "clicked; value=Ada"
方式A core: VALIDATED ✓
```

学び:
- Chrome検出はOS別の候補パス総当たりで十分（Chrome/Chromium/Edge/Brave）。
- `connectOverCDP` は「自分で起動した外部ブラウザにアタッチ」。Playwrightに起動させるのとは別。
- **AXツリーは `locator.ariaSnapshot()`**（role+nameのYAML）。旧 `page.accessibility.snapshot()`
  は現行Playwrightで廃止。座標非依存でトークンも軽く、AIに渡すのに最適。
- スクショ1枚取得も確認＝C2のscreencast実現性OK。

### モジュール対応（実装時）

| spike | 実モジュール |
|---|---|
| detectChrome / 起動フラグ | `src-tauri/src/browser.rs`（std::process spawn。C1は重いCDPクレート不要） |
| connectOverCDP / navigate / ariaSnapshot / actions | `src/browser-controller.ts`（CDPはWebSocketエンドポイント直叩き。CSP=nullなのでwebviewから可） |
| screenshot→canvas | C2のみ: `Page.startScreencast` → レイヤー`<canvas>` |

注意: 実アプリのTS側は **Playwright не使えない**（Node専用）。webviewからは
**生CDP（WebSocket JSON）** を話す。AXは `Accessibility.getFullAXTree` を自前でflatten、
操作は `Input.*`/`Runtime.*`。方式Aの核はspikeで証明済みだが、生CDP実装＋Tauri配線は
実機ビルドの往復が要る（CEFと同様、`pnpm tauri build` のリリースビルドで検証すること）。

### 安全・哲学

破壊的操作（送信/購入/削除）は人間確認を挟む。自動操作は既定オフ。既存の「人が主導」
哲学（CLAUDE.md のクロスエージェント方針）と整合。
