---
title: "macOS 26 で vim が映らない — WKWebView 合成バグ (wry#1848) 調査記"
date: 2026-10-25
dg-publish: true
tags:
  - tauri
  - wkwebview
  - macos
  - xterm
  - debugging
  - post-mortem
---

# macOS 26 で vim が映らない — WKWebView 合成バグ (wry#1848) 調査記

Tauri + xterm.js で作っている自作ターミナル（複数の Claude Code を並列で動かすアプリ）で、**vim がどうしても使えない**という問題に長く付き合った。最終的に犯人は自分のコードではなく **macOS 26 の WKWebView の描画バグ**だった、という話。同じ沼にハマる人のために、切り分けの筋道と教訓を残す。

## 症状 — 「dev では動く、build では固まる」

- `pnpm tauri dev`（開発ビルド）で vim を開く → **ちゃんと動く**。
- `pnpm tauri build`（配布ビルド）の `.app` で vim を開く → **最初の1フレームで画面が固まる**。入力しても、画面上は空の vim（`"test.txt" [New]`）のまま、何も変わらない。

「dev と build で挙動が違う」。この時点で多くの人（自分も）は「本番ビルドで何か“部品”が抜けているのでは」「ミニファイで壊れたのでは」と疑う。だが、犯人はもっと厄介なところにいた。

## 最初の誤解 — DevTools に騙される

dev と build の一番大きな違いは **DevTools（WKWebView の Web Inspector）** の有無だ（debug ビルドには付き、release には付かない）。「Inspector がレイヤーを再描画し続けてバグを隠しているのでは」という仮説を立てた。

これは**筋が良さそうで、外れだった**。release ビルドに `devtools` フィーチャを足して Inspector 付きでビルドしても、vim は固まったまま。Inspector 説は否定された。

そして CSS 側も疑った。`.stack` の 3D コンテキスト撤去、前面レイヤーの de-promote、`.xterm-screen` へのあらゆる再描画ナッジ（opacity / transform / filter / reflow）、ウィンドウのリサイズ、DOM↔WebGL のレンダラ切替……**全部効かなかった**。しかも、どれも「全く同じように」効かない。この「どの手も同じように無力」という感触が、後から思えば最大のヒントだった。

## 決定打 — `cat test.txt` で入力と表示を切り離す

長く迷走した原因は、「入力が壊れているのか、表示が壊れているのか」を混同していたことだった。画面が固まっていると、キーが効いているのかどうかすら分からない。

そこで**画面を一切信用しない**切り分けをやった。vim で盲打ちで `i` → `HELLO` → `Esc` → `:wq` と打ち、閉じたあとにシェルで：

```sh
cat test.txt
# → HELLO
```

**ファイルには `HELLO` が書かれていた。** つまり：

- 入力はちゃんと届いている
- vim も動いている（挿入・保存・終了まで実行された）
- **壊れているのは「画面の再描画」だけ**

この `cat <file>` 一発で、何日も曖昧だった「入力か表示か」が一瞬で確定した。**表示が死んでいても、実体（ファイル）は生きている**——これを確かめるのが早すぎるほど早くやるべきだった。

## 証拠 — DOM は最新、ピクセルだけ古い

アプリに仕込んだダンプ（`Alt+Shift+D`）で、xterm のバッファと DOM の状態を同時に吐かせた：

```
vim-dump: buf normal nonEmpty=26/27 | DOM rows=27 nonEmpty=26
DOM 0|HELLO
```

**DOM には `HELLO` が入っている。** なのに画面は空のまま。これは「xterm が描けていない」のでも「データが来ていない」のでもなく、**ブラウザ（WKWebView）が、更新された DOM を画面に“提示(present)”していない**という、純粋な合成（コンポジット）の問題だった。

ダメ押しで、通常画面（スクロールするシェル）はどうか試した：

```sh
for i in 1 2 3 4 5; do printf "\rcount: $i"; sleep 1; done
# → 1 → 2 → 3 → 4 → 5 とちゃんとアニメーションして見える
```

**動く／増える領域（スクロール・追記）は提示される。固まるのは「全画面の一括書き換え」だけ。** 当初は「alt-screen（vim が使う代替画面）だけが悪い」と考え、alt-screen を無効化して通常バッファで描かせる回避策を入れた。が、**通常バッファでも全画面の一括書き換えは固まった**（ダンプで `type=normal` かつ DOM は最新、でも画面は死）。alt-screen は本質ではなかった。

## 真犯人 — macOS 26 の WKWebView コンポジタ

ここまで来て、ようやく「自分のコードではない」と腹をくくって上流を探した。すると一致する報告があった：

**[tauri-apps/wry#1848 — WKWebView stops presenting frames (stale/partial frames)](https://github.com/tauri-apps/wry/issues/1848)**

> macOS 26 / Apple Silicon の release ビルドで、**DOM と アクセシビリティツリーは生きたまま、WKWebView が新フレームを画面に提示しなくなる**。

症状・OS・バージョンがぴったり一致した（こちらは MacBook Pro M3 Pro / macOS Tahoe 26.6.2 / wry 0.55.1 / tauri 2.11.2、報告は 0.55.1 / 2.11.5）。**macOS 26 の WebKit のリグレッション**で、上流に修正はまだ無い。`backdrop-filter: blur()` や transform/opacity アニメによる「レイヤー churn」が誘発要因として挙がっている。

つまり、30 回以上のビルドを費やして試した CSS・レンダラ・レイヤーの工夫が「どれも同じように無力」だったのは当然で、**webview の内側からはそもそも直せない**種類のバグだった。

## 解決 — 端末を直すのをやめ、エディタを足す

結論はシンプルだ。

- **macOS 26 では webview 内の端末で全画面 TUI を映すのは不可**（上流修正待ち、またはネイティブ描画）。
- しかし**編集したいだけ**なら、端末 vim に固執する必要はない。**DOM ベースのエディタ・レイヤー**（CodeMirror など、ふつうの HTML 要素）を足せばいい。通常 HTML はちゃんと再描画される（`count` が動いたのと同じ理屈）ので、このバグを**丸ごと迂回**できる。
- vim / less / htop 等の端末 TUI は、**Windows / Linux / 旧 macOS では従来どおり動く**。Windows は WebView2（Chromium）、Linux は WebKitGTK で、そもそも WKWebView ではないため無縁。

（余談：Windows 版は別のバグで起動すらできなかった。`default_shell` が `/bin/zsh` を返していて、Windows にそれは無いので spawn 失敗。`cmd.exe` に直して解決。これは「本番で部品が足りない」系の、ごく普通のクロスプラットフォームのミスだった。）

## 教訓

1. **端末描画の検証は、必ず release ビルド（`pnpm tauri build`）で。** `tauri dev` の DevTools / debug 構成がこの手の合成バグを隠す。「dev で直った」は信用してはいけない。ロジックやレイアウトの確認には dev/HMR で十分だが、描画の最終確認は release で。
2. **`cat <file>` は最強の切り分けツール。** 画面が死んでいても、ファイルの中身を見れば「入力・処理は生きているか」が一瞬で分かる。表示バグと入力バグを混同しないこと。
3. **「DOM は最新なのに画面が古い」＝合成/提示の問題。** DOM ダンプと実画面を突き合わせて、ピクセルが stale なら、それはレンダラやデータの問題ではなく、ブラウザ（WebView）が描き直していないということ。自分のコードを疑う段階を一つ卒業できる。
4. **どの小細工も「同じように」効かないときは、プラットフォームを疑う。** CSS も、レンダラも、レイヤー構成も、リサイズも、全部同じ結果（無力）なら、問題は自分のコードの外（OS / WebView）にある可能性が高い。早めに上流の issue を漁ろう。

長い沼だったが、「自分のコードのバグではない」と**証拠をもって**言い切れたこと、そして「端末を直す」から「エディタを足す」へと**問題の立て方を変えられた**ことが収穫だった。

---

- 上流 issue: [tauri-apps/wry#1848](https://github.com/tauri-apps/wry/issues/1848)
- 技術レポート: `docs/2026-10-24-macos26-wkwebview-altscreen.md`
- 調査の全時系列: `docs/2026-07-15-vim-debugging-journey.md`
