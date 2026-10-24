# なぜ vim だけが死んだのか — xterm.js を疑い続けて、PTY に辿り着くまで

*2026-07-15 / ai-development-terminal-max の開発記録*

自作ターミナル（Tauri + xterm.js）で **vim だけが動かなかった**。`nano` は動く。Terminal.app でも cmux でも vim は動く。**このアプリの中でだけ**、vim は開いた数秒後に死ぬ。

原因に辿り着くまで、およそ **30 回のビルド＆差し替え**を空振りした。そのほとんどが「xterm.js が悪い」という**誤った前提**の上で回した実験だった。真因は xterm.js ではなく、**自分で書いた Rust の PTY リーダー 5 行**にあった。

この記事は、その回り道の記録である。

---

## 1. 症状

| 現象 | 観測 |
|---|---|
| このアプリで `vim file` | 開くが、数秒後に死ぬ。入力が効かない。抜けられない |
| このアプリで `nano file` | **問題なし** |
| Terminal.app / cmux で `vim` | **問題なし** |
| `TERM=vt100 vim -u NONE` | **この時だけ**入力が効く |
| `stty size` | `22 49` — 正しい |

「nano は動くのに vim は動かない」「他のターミナルでは動く」。この 2 つが手がかりの中心だった。**そして、その解釈を間違えた。**

## 2. 誤った推理の連鎖

「vim と nano の差は何か？」と問い、こう答えてしまった：

> **vim は代替画面（alternate screen / DECSET 1049）を使う。nano は使わない。`TERM=vt100` だと vim は代替画面を使わない。だから代替画面まわりが壊れている。**

一見きれいに全部を説明できる。だから疑わなかった。**これが 30 回の空振りの出発点**である。

この前提のもと、以下を順に試した。すべて外れ：

| 試したこと | 理屈 | 結果 |
|---|---|---|
| `refitSoon()` でサイズ再計算 | サイズ不整合では | ❌ |
| EINTR リトライ | シグナルで read が中断？ | ❌（惜しかった／後述） |
| DECSET 1004（フォーカス報告）の抑制 | フォーカス洪水で入力が詰まる？ | ❌ |
| **WebGL レンダラを無効化** | WebGL が alt-screen を描けない？ | ❌ |
| **3D CSS（perspective/preserve-3d）を削除** | 3D コンテキストが描画を壊す？ | ❌ |
| 強制 `refresh()` | 描画ループが回っていない？ | ❌ |
| **theme 再代入で強制再描画** | キャッシュ無効化で全面再描画 | ❌ |
| xterm.js を 5.5 へダウングレード | 6.0 の回帰では？ | ❌（依存衝突で断念。そもそもユーザ談「ずっと見えない」＝回帰ではない） |

ユーザからの指摘が刺さった：

> 「ダウングレードって危険じゃない？ 5.5 から 6 にアップデートしたんだからこれが原因とも思えない」

正しい。**「最近変えたもの」を疑うのは定石だが、「ずっと壊れている」なら回帰ではない。** 症状の履歴を確認せずに犯人を探していた。

## 3. 転機 — 内部状態をダンプする

推測でビルドを回すのをやめ、**xterm の内部状態を直接吐かせた**：

```
key'f' buf=alternate 47x22 el=346x310 vis=Y
```

読み方：

- `buf=alternate` → **代替画面への切り替えは成功している**
- `47x22` → サイズは正しい
- `el=346x310` → 描画要素に寸法がある
- `vis=Y` → 可視である

**セットアップは完璧だった。** つまり「代替画面に入れていない」系の仮説は全部死んだ。ここでようやく、症状が**2層**に分かれていることが見えた：

1. **入力／プロセス生存の問題**（vim が死ぬ）
2. **表示の問題**（代替画面が描画されない）

**この 2 つを混ぜて 1 つの原因を探していたことが、迷走の本質だった。**

## 4. 真因（入力側）— PTY リーダーの 5 行

Rust 側のリーダースレッドはこう書かれていた：

```rust
match reader.read(&mut buf) {
    Ok(0) | Err(_) => break,   // ← これ
    ...
}
let _ = app.emit("pty-exit", exit_id);
```

**`Err(_) => break`。あらゆる read エラーを「プロセス終了」と見なしていた。**

すると連鎖が起きる：

```
一時的な read エラー
  → break → pty-exit を emit
  → フロントがレイヤを閉じる
  → シェルが閉じる → SIGHUP
  → 全画面の子プロセス（vim）が道連れで死ぬ
```

macOS は**子プロセスが生きているのに** read エラーを一時的に返すことがある。そして **vim は起動時に端末へ大量のクエリを撃つ**。これがエラーを誘発していた。

**なぜ nano は無事だったのか。** nano はその起動時クエリを撃たないから。

つまり「vim と nano の差」は**代替画面ではなく、起動時の端末クエリ**だった。**手がかりは正しかったが、差分の解釈を間違えていた。** 同じ観測から、真逆の場所へ歩いて行ってしまった。

修正は「本当に死んでいるか確かめてから終了扱いにする」だけ：

```rust
Err(_) => {
    let alive = child_pid != 0
        && unsafe { libc::kill(child_pid as libc::pid_t, 0) } == 0;
    errs += 1;
    if alive && errs < 50 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        continue;   // 生きてる。ただのしゃっくり
    }
    reason = "err";
    break;
}
```

`kill(pid, 0)` はシグナルを送らず**存在確認だけ**する常套句。これで vim は死ななくなった。ファイルも保存できる。**入力側は完全に解決。**

## 5. まだ解けていない（表示側）

vim の**代替画面が描画されない**問題は残っている。分かっていること：

- 内部状態は完璧（`buf=alternate 47x22 el=346x310 vis=Y`）
- **強制的に全面再描画してもダメ** → 「描画ループが回っていない」より深い
- WebGL では真っ白、DOM レンダラでは初回のみ描画

**有力な仮説（未確定）**：**xterm.js × WKWebView（WebKit）の相性問題**。

- VS Code / Hyper など xterm.js 系は **Electron（Chromium）**上で動き、この問題は出ない
- **cmux はそもそも xterm.js を使わず、ネイティブ WKWebView で描画**している（だから無傷）
- このアプリは **Tauri = WKWebView（Safari エンジン）**

xterm.js は主に Chromium で開発・検証されている。WKWebView 側の描画差分を踏んでいる可能性が高い。

**なお `@xterm/addon-canvas` は選択肢にならない**：deprecated で、**`@xterm/xterm` v6 で削除済み**（[cockpit#22509](https://github.com/cockpit-project/cockpit/issues/22509)）。xterm.js の推奨は **WebGL（第一）／DOM（フォールバック）**の 2 択（[#3271](https://github.com/xtermjs/xterm.js/issues/3271)）。**その両方が効かない**＝レンダラ選択の問題ではない、という補強証拠でもある。

**次の一手**：バッファの中身を直接ダンプする（`getLine().translateToString()`）。「描画されないだけ」なのか「そもそもバッファが空」なのかを確定させる。強制再描画が効かなかった以上、後者の可能性も残る。

**当面の回避策**：`echo 'set t_ti= t_te=' >> ~/.vimrc`（vim の代替画面を無効化＝通常画面にインライン描画。実用上は普通に使える）。または `nano`。

## 6. 学び

### ① 「動くもの」と「動かないもの」の差分は最強の手がかり — だが解釈を間違えると最悪の罠になる
nano/vim の差は正しく捉えた。しかし「代替画面」と解釈した瞬間、**全ての観測がその仮説を裏づけるように見え始めた**。実際の差は「起動時クエリ」だった。**手がかりの解釈には、それ自体の検証がいる。**

### ② 症状を層で分けろ
「vim が動かない」は **①死ぬ（プロセス）** と **②見えない（描画）** の 2 つだった。混ぜたまま 1 つの原因を探したので、片方の証拠がもう片方の仮説を汚染し続けた。

### ③ 推測でビルドを回すな。内部状態を吐かせろ
30 回の空振りは、ほぼ全部「仮説 → ビルド → 差し替え → 目視」のループ。**1 回の状態ダンプ**（`buf=alternate ...`）が、それら全部より多くを語った。**計測は推測より速い。**

### ④ 「他のアプリでは動く」＝ 自分のコードを疑え
Terminal.app と cmux で動くなら、犯人は**このアプリ固有のコード**である可能性が最も高い。にもかかわらず、疑い続けたのは**サードパーティ（xterm.js）**だった。自作の PTY 層こそが最も疑わしかったのに。

### ⑤ 「最近変えた」は定石だが、「ずっと壊れている」なら回帰ではない
xterm 5.5→6.0 のアップデートを疑ったが、症状は**ずっと前から**出ていた。**症状の履歴を先に確認する。**

### ⑥ 地雷リストを残す（＝この記事の存在理由）
空振りした実験を**コミットで残すとノイズになる**が、**どこかに残さないと必ず二度掘る**。だから「試したがダメだった手」を文書に残す。コミット履歴は「確定した修正」だけに保つ。

---

## 付録：試したがダメだった手（地雷リスト）

再挑戦する前に、ここを読むこと。すべて**ビルド＆差し替えを 1 回ずつ消費**している。

- ❌ `refitSoon()` によるサイズ再計算
- ❌ DECSET 1004（フォーカス報告）の抑制 ※予防として残置。**vim の原因ではない**
- ❌ WebGL レンダラの無効化（DOM へフォールバック）
- ❌ `.stack` の 3D CSS（`perspective` / `transform-style: preserve-3d`）削除
- ❌ 強制 `refresh()`
- ❌ `options.theme` 再代入による強制全面再描画
- ❌ xterm.js 5.5 へのダウングレード（依存衝突で断念。前提自体が誤り）
- ❌ `@xterm/addon-canvas` への切り替え → **v6 で削除済み。存在しない**

**効いた唯一の修正**：`pty.rs` の `kill(pid, 0)` 生存確認（＝入力側）。

**未解決**：代替画面の描画（＝表示側）。次は**バッファ内容のダンプ**から。

---

## 2026-09-27 追記：カーソル位置レポートの無限ループを実測（入力側の真因候補）

ユーザーの指摘「問題は再描画ではなく vi でコントロールできていないこと」を受け、`Alt+D`
の入出力トレースを画面に出して実測した。**アイドルの shell プロンプトでも**（vim を開いて
いなくても）以下が延々と流れ続けることを確認：

```
OUT  27,91,63,54,110         = ESC [ ? 6 n        ← 子プロセスがカーソル位置を要求 (DECXCPR)
data 27,91,63,50,53,59,52,82 = ESC [ ? 2 5 ; 4 R  ← xterm が自動応答 → PTY へ書き戻し
（以下 shell / claude 両ペインで無限に繰り返し）
```

- **入力は PTY に届いている**（`data:… pty=Y`）＝「キーが届かない」問題ではない。
- **`\e[?6n`→`\e[?25;4R` の自動応答ループが PTY を洪水にしている**。これが実キー入力を
  埋もれさせ、「vim を操作できない」症状の最有力候補。Terminal.app では同じ zsh でも
  ループしない＝アプリ側の応答が起点。
- claude 固有でも z-depth（前面化）でもない。**端末レイヤ共通**の問題。

**候補修正**：CSI ガード登録を `src/terminal-guards.ts` に抽出し、既存の 1004 抑制と
同じ手法で、私的 DSR の `\e[?6n`（DECXCPR）だけ
`registerCsiHandler({ prefix: "?", final: "n" })` で握りつぶして xterm の自動応答を止める。
vim が使う素の `\e[6n`（`?` なし）は既定ハンドラのまま温存。

**テスト基板（headless・sandbox で自動実行できる）**：`src/terminal-guards.test.ts`。
`@xterm/headless`（DOM 無し・同じパーサ）にガードと同じ登録を適用し、以下を自動検証：
- ガード無し → `\e[?6n` に `\e[?1;1R` を**自動応答する**（＝ループの発生源を再現）
- ガード有り → `\e[?6n` は**応答ゼロ**（＝ループを断つ）
- ガード有りでも素の `\e[6n` は応答（vim のサイズ検出を壊さない）
- 1004 抑制は維持／`\e[?1049h`（代替画面）は壊さない

これで**入力側（応答→PTY 書き戻し）の真因と修正は WKWebView 無しで確定**した。

**実機で残る確認**（headless では不可能）：リビルド後 `Alt+D` ON でアイドル放置し、
`\e[?6n`/`\e[?25;4R` 行が**止まるか**＋ vim を実操作できるか。ここで初めて
「操作不能」が解けたと言える。止まらなければ「応答起点ではなくタイマー/フォーマット
起点」と判明するので次手へ。

## 2026-10-09 追記：入力は解決・描画は切り分け中（実機で確認した事実）

リビルド後、実機で確認できたこと：

- ✅ **カーソルレポートのループは消えた**（`Alt+D` でアイドル放置しても `\e[?6n`/`\e[?25;4R` が流れ続けない）。入力トレースでも打鍵が PTY に届き（`data:… pty=Y`）、vim が応答を返す（`OUT` に hide/show cursor + 文字）ことを確認。**「操作不能」の主因＝ループは解消で確定。**
- ❌ でも **画面は更新されない**。vim で `i`→入力→`:wq` しても見た目が変わらず、保存終了もできない。
- 🔎 `set t_ti= t_te=`（通常画面描画）にすると **初期フレームは描かれた**（`~` 列＋ステータス行が見えた）が、**打鍵後の更新は描かれない**。
- ❌ **#53（xterm の IntersectionObserver 描画停止を無効化）を投入 → 効果なし**。render-pause は（少なくとも単独では）主因ではない、と判明。地雷リストに追加。

→ 残る仮説は **「WKWebView が xterm の DOM 更新を再合成しない」** の一点。これを確定するため、
**`Alt+Shift+D` の dump に DOM 側（`.xterm-rows` の行数・ジオメトリ・computed transform/visibility/opacity・各行の textContent）を追加**済み。次回は実機でこれを取り、
- DOM に打鍵内容が入っているのに画面が黒 → **合成の問題**（未試行：コンテナへ微小 transform 等で再ラスタライズ強制）
- DOM が空/古い → **xterm レンダラ側の問題**
- `rows.css` が高さ0/opacity0/hidden → **CSS/レイアウトで直せる**
のどれかに一意に絞る。**実現可能性自体は高い**（cmux はネイティブ描画でこの壁を回避済み＝最終手段として確実な道がある）。安価なインプレース修正が可能かは DOM dump 次第。

**地雷リスト追加**：
- ❌ `set t_ti= t_te=`（インライン描画）＝ループ解消後も**更新は描かれない**ので回避策にならない
- ❌☠️ **IntersectionObserver 無効化 #53（`window.IntersectionObserver = undefined`）は回帰バグ**。`DOM rows=0`／**全ターミナル黒**を引き起こした。原因：xterm の `_registerIntersectionObserver` は `"IntersectionObserver" in window` で判定するため、`= undefined` でもキーは残り true → `new undefined(...)` で**例外**→ `term.open()` が失敗してレンダラが起動しない。**revert 済み。** もし将来 render-pause を切るなら `delete window.IntersectionObserver`（キーごと消す）で、かつ skip 時の `_isPaused` 既定値を確認してから。ただし「render-pause が vim 代替画面の原因」はまだ**未確認**（この `DOM rows=0` は #53 のバグ由来で、vim 本来の状態ではない）。revert 後にクリーンな状態で再計測すること。

## 2026-10-11 追記：合成問題と確定 → 3Dコンテキスト撤去を検証

#53 を revert してクリーンな状態で `Alt+Shift+D` を再計測：

- インライン（通常画面）: `buf normal nonEmpty=21/27 | DOM rows=27 nonEmpty=21`
- 代替画面: `buf alternate nonEmpty=21/27 | DOM rows=27 nonEmpty=21`

**両方とも DOM に行が埋まっている（27行・21行に中身）のに画面に出ない／操作できない。**
→ 真因は **「DOMには描けているが WKWebView がそのDOM更新を再合成(composite)しない」合成問題**と**計測で確定**。バッファでもレンダラ起動でもない。

**対処（検証中）**: `styles.css` の `.stack` から `perspective` / `transform-style: preserve-3d` を撤去。
- 根拠：`.layer.behind` の変形は `translateY`+`scale` の**2Dのみ**で `translateZ` 等の3Dは不使用。つまり 3D レンダリングコンテキストは**実質無駄**なのに、WebKit で子要素(xterm行)の再ラスタライズを止める副作用だけを持っていた。
- 期待：見た目のデッキは 2D 変形＋`z-index` で維持され、`front`(z20) が `behind`(z≈9) の上に来るので「黒が上に来る」も解消見込み。
- 注意：CLAUDE.md 地雷リストに「3D CSS 削除＝効果なし」とあるが、当時はループ未修正・#53混入で条件が異なり、かつ今回「DOMは埋まっている＝合成問題」という計測証拠が揃った上での**根拠つき再検証**。これで駄目なら合成強制(`translateZ(0)` トグル等)かネイティブ描画へ。

## 2026-10-16 ✅ 解決（実機確認）

`pnpm tauri dev` の devビルド（`.stack` の3Dコンテキスト撤去入り）で、**代替画面vimが表示・操作できることを実機確認**。`i`→入力→`:wq` が通り、Solarized Dark も正常。長期未解決だった「display side」はこれでクローズ。

**最終的な真因（2つ）**：
1. **入力**：カーソルレポートのループ（`\e[?6n`→`\e[?25;4R`自動応答→PTY書き戻し→無限）が打鍵を埋もれさせていた → `terminal-guards.ts` で私的 `\e[?6n` を握りつぶし。
2. **描画**：`.stack` の `perspective`/`preserve-3d`（2D変形しか使わない**無駄な3Dコンテキスト**）内で、WKWebViewが xterm の DOM 更新を再合成しなかった → 撤去。`Alt+Shift+D` の `DOM rows=27 nonEmpty=21`＋黒画面が「合成問題」の決定的証拠だった。

**教訓**：
- 「3D CSS 削除」は過去に地雷認定されていたが**実は正解**。当時はループ（入力側）がまだ生きていて効果が覆い隠されていた＝**複合バグは一つずつ潰してから再評価する**。
- 再現不能な WKWebView バグは、盲目リビルドより **`Alt+Shift+D` の DOM 計測**＋**`pnpm tauri dev` の DevTools/HMR 生検証**が圧倒的に速い。
- #53 の教訓：`window.IntersectionObserver = undefined` は `new undefined()` 例外で全黒。消すなら `delete`。

---

*関連 PR: [#34](https://github.com/foresthill/ai-development-terminal-max/pull/34)*

## 2026-10-18 ⚠️ 再オープン：release で再発 — devビルドの DevTools がバグを隠していた

0.1.3 を**リリースビルド（`pnpm tauri build`）**して配布物で動かしたら、**vim がまた黒い**。
`pnpm tauri dev` では動くのに、`.app`（release）では動かない。

### 切り分け（リビルド不要でやれた）

1. **本番バンドルの CSS を確認** → `dist/assets/*.css` に `.stack{...z-index:0}` のみ。
   `preserve-3d`/`perspective` は**ちゃんと消えている**＝ 3Dコンテキスト撤去の修正は release にも入っている。CSS は犯人ではない。
2. **release 実機でダンプ**（`Alt+Shift+D` → `Alt+Shift+C`）：
   ```
   vim-dump: buf alternate nonEmpty=21/27 | DOM rows=27 nonEmpty=21
   ```
   → **DOM は 21 行埋まっているのに画面は黒**。dev のときと**同じ合成問題が release でも起きている**。
3. **dev と release の差**：`src-tauri/Cargo.toml` の `tauri = { version = "2", features = [] }`
   → `devtools` フィーチャ無し。Tauri 2 は **debug（`tauri dev`）では WKWebView の Web Inspector が有効、release では無効**。

### 結論（2026-10-16「解決」は偽陽性だった）

**WKWebView は Web Inspector が有効なあいだ、レイヤーを再ラスタライズし続ける。** これが合成バグを
**隠していた**。だから dev では vim が動いて見えた。release では Inspector が無い → バグが素のまま出る。

- `.stack` の 3Dコンテキスト撤去は**必要**だったかもしれないが、**それだけでは不十分**。
- 入力側（カーソルレポートのループ → `terminal-guards.ts`）の修正は依然として有効・独立。
- **真因（表示側）は未解決の WKWebView 合成バグ**。`DOM rows=27 nonEmpty=21`＋黒 がその決定的証拠。

### いちばん大事な教訓（過去の教訓を上書き）

> **端末描画の修正は、必ず `pnpm tauri build` の release（.app）で検証する。`tauri dev` で確認してはいけない。**
> `tauri dev` の DevTools が合成バグを隠すため、dev での「直った」は信用できない。
> （ロジック・レイアウト・テーマ配色の確認には dev/HMR/DevTools は今でも有効。）

これは 10-16 の「`tauri dev` の DevTools/HMR 生検証が圧倒的に速い」を**合成バグに関しては撤回**する。
速いが、嘘をつく。

### 旧 dead-end リストの扱い

表示側の「dead-end」判定（refit-on-toggle / DECSET 1004 / WebGL 無効化 / 強制 `refresh()` /
`options.theme` 再代入 / xterm 5.5 ダウングレード / `@xterm/addon-canvas`）は**すべて dev ビルド＝
DevTools マスク下での評価**だった。合成バグに対しては**判定が無効**。再挑戦するなら **release で**。
（`window.IntersectionObserver = undefined` の全黒＝`new undefined()` 例外、`set t_ti= t_te=` が
更新を描かない、の2点は機構的に確かなので dead-end のまま。）

### 次の一手（release で検証すること）

Inspector がやっている「再ラスタライズの強制」をコード側で再現する。安い順：
1. 前面 `.layer`（または `.xterm-rows`/`.xterm-screen`）を**合成レイヤーにキャッシュさせない**
   （`will-change` 調整・レイヤー昇格要因の除去）。
2. `term.onRender` ごとに `.xterm-screen` へ**ラスタ無効化のナッジ**（**2D の** transform/opacity/
   filter トグル。`translateZ` 等の 3D は**厳禁**＝元のコンテキストが復活する）。
3. 最終手段：ネイティブ描画（cmux 方式）。

---

*2026-10-18 時点: 表示側は OPEN。入力側は CLOSED。リリース 0.1.3 のノートにある「vim 修正中」は正しい。*

### テストベンチ（2026-10-18 追加）— 1ビルドで複数の再描画戦略を試す

release の実機検証は1回約8分と高価なので、`agent.ts` に**再描画(recomposite)戦略ベンチ**を仕込んだ。
各ターミナルの `term.onRender` でアクティブ戦略を実行し、**Alt+Shift+V** で戦略を巡回できる（トーストに番号表示）。

戦略一覧（すべて 2D のみ。`translateZ`/3D は厳禁＝元の詰まりが復活する）：
- `0 off` … ベースライン（素の状態。まず黒いことを確認）
- `1 screen opacity` … `.xterm-screen` の opacity を 1↔0.9999
- `2 screen translateY(2D)` … `.xterm-screen` に微小 translateY
- `3 screen filter` … `.xterm-screen` に `opacity(0.999)` フィルタ
- `4 screen will-change:contents` … キャッシュ抑制ヒント（静的）
- `5 screen display reflow` … 毎フレーム reflow 強制（ちらつく＝最終手段の切り分け用）
- `6 layer opacity` / `7 layer translateY(2D)` … 合成の親候補 `.layer-terminal` 側を叩く

**手順（release .app で）**：vim を開く → 黒い → Alt+Shift+V を押して戦略を1つずつ試す →
vim が見える番号を記録 → その戦略を正式実装（毎renderは重いので必要なら間引く）に昇格。
効く番号が分かれば「どの要素のどの性質を変えると WKWebView が再ラスタライズするか」も分かる。
ベンチは TEMP。正式修正が決まったら撤去する。

### 2026-10-18（続き）根本原因に踏み込む — 「devは描けてbuildは黒」の差を特定しにいく

ベンチ（1-7）は対症療法（再描画の強制）であって**根本原因の特定ではない**、という指摘を受けて、
dev と release の**実際の差**を2系統、具体的に詰める。

**差その1：DevTools(WebInspector) の有無（決定実験）**
`tauri = { features = [] }` なので debug(`tauri dev`)はInspector有効・release無効。Inspectorは
WKWebViewに常時再描画を強制しうる＝バグを隠しうる。→ **release に `features=["devtools"]` を付けてビルド**し、
- vim が描ける → 「Inspector/`isInspectable` 非搭載時に再ラスタライズしない」で**原因確定**。
- vim が黒いまま → Inspector は原因ではない → 差その2へ。
（この実験のため Cargo.toml を一時的に `features=["devtools"]` に。**出荷前に `[]` へ戻す**。）

**差その2：前面レイヤーの合成昇格（本番CSSを精査して判明した筋の良い容疑者）**
`dist` の本番CSSで `.layer`（前面vimのコンテナ）に：
```css
.layer{ overflow:hidden; border-radius:6px; transition: transform .18s, opacity .18s, filter .18s }
```
`transition`（transform/opacity/filter）も `overflow:hidden + border-radius` のクリップも、WebKitで
**要素を合成レイヤーへ昇格**させる典型要因。昇格した合成レイヤーは**子孫テキストの変更だけでは
再ラスタライズされない**ことがある＝今回の症状と一致。dev では Inspector がそれを隠していた、で筋が通る。
→ ベンチに**de-promote 戦略**を追加：
- `8 layer no-transition` … 前面 `.layer` の `transition` を切る
- `9 layer no-clip` … 前面 `.layer` の `overflow/border-radius` を外す
これは 1-7 の「毎フレーム叩いて再描画させる」対症療法と違い、**昇格要因そのものを除く根治候補**。

**次ビルドの読み筋**
1. まず **devtools 付き release** で vim が出るか（差その1の判定）。
2. 出るなら原因確定 → 次は devtools を外し、8/9（de-promote）で**出荷可能な根治**ができるか。
3. devtools 付きでも黒いなら Inspector は無関係 → 8/9 や配信プロトコル（`tauri://` 独自スキーム）を追う。

### 2026-10-20 ✅（表示side・release実機で確定）／入力sideは未解決

release .app（devtools付き）で **Alt+Shift+V** のベンチを回した結果：
- **devtools を載せても vim は黒（B）** → 「Inspector搭載で直る」説は否定（＝dev/buildの差はInspector有無ではない）。
- **戦略 8（layer transition除去）でも 9（layer clip除去）でも vim が“見える”** → **表示の真因は
  前面 `.layer` の合成レイヤー昇格で確定**。`.layer` の `transition`（transform/opacity/filter）と
  `overflow:hidden+border-radius` が前面paneを合成レイヤーに昇格させ、release WKWebView が
  子孫テキストの変更で再ラスタライズしない、という機構。dev では（理由は別として）この昇格が
  問題化していなかった。

**恒久修正（表示）**: `.layer.front { transition: none }` を追加。前面（アクティブで静止している）paneの
transition を切って de-promote。角丸・クリップは維持（9の「角丸が消える」副作用を避けられる）。
behind paneは transition を残すのでデプスのアニメは保持。副作用は「前面paneが切替時にアニメINしない」
程度。→ 次の release ビルドで再確認する（PROCESS RULE）。

**ただし入力sideは未解決**: 8/9 で**見えるが打てない**。vim(代替画面)にキーが届いていない。
通常シェルは打てる＝alt-screen固有。入力トレーサ（Alt+D → 打鍵 → Alt+Shift+C）で
「window→xterm→onData→pty」のどこで消えるかを特定して追う。

### 2026-10-20（続き）入力トレースの決着 — 「打てない」の正体はフォーカス奪い返し

release でクリック→打鍵のトレースを取得。判明：
- **入力は完全に生きている**。キーは pty まで届き（`data pty=Y`）、クリックで前面 vim(99x27) に入ると
  **vim は `-- INSERT --` を返し、`f d i s` をエコー**＝受信して応答している。
- しかしトレース末尾で **`win:'Alt' buf=alternate 47x11`** ＝ **フォーカスが別エージェント(claude 47x11)へ
  “戻って”いる**。

**機構**：端末クリックは xterm の textarea に**DOMフォーカス**を直接当てるが、アプリ状態 `this.focused` は
更新されないことがある。すると**次の render が `term.focus()` で `this.focused`（古いまま）の端末を再フォーカス**し、
DOMフォーカスを奪い返す。結果、「vim に入れたのに気づくと外れて別窓(claude)に入る」＝“vimが打てない”。

**修正**：`agent.cardEl` に `focusin` リスナを追加し、**どの端末にフォーカスが入っても `this.focused` が追従**
するように（app.ts）。`focus()` は同一indexなら早期return なので、render の programmatic focus とループしない。
これで「見ている窓＝キーが入る窓」が常に一致する。

**devtools プローブの結果**：`features=["devtools"]` の release でも vim は黒だったため、Inspector 説は**否定**。
Cargo.toml を `features=[]` に戻した。表示の真因は前面レイヤーの合成昇格（修正済み）。

**次ビルドで検証（表示修正＋フォーカス修正の合わせ技）**：
release を `pnpm tauri build` → vim を開く → **クリックして打つ → 文字が見えて、フォーカスが外れない** か。
これで表示・入力・フォーカスが揃うはず。

## 2026-10-24 ✅ 決着 — macOS 26 WKWebView のコンポジタバグ（wry#1848）と確定、alt-screen無効化で回避

release 実機で決定的データが揃った：
- `cat test.txt` = **HELLO**（入力・vim・保存は全部正常）／`Alt+Shift+D` = `DOM 0|HELLO`（DOMも最新）
  なのに画面は空のまま＝**ピクセルだけ古い＝WKWebViewが新フレームを提示していない**。
- DOM/WebGL 両レンダラ、レイヤー1枚、ウィンドウリサイズ、devtools有効化——**すべてで固まる**。
- 通常画面は正常（`printf '\rcount: $i'` が 1→5 で動く）。**固まるのは alt-screen だけ**。
- 環境: MacBook Pro M3 Pro / **macOS 26.6.2 (Tahoe)** / wry 0.55.1 / tauri 2.11.2。
- 上流 **[wry#1848](https://github.com/tauri-apps/wry/issues/1848)** と症状・OS・版が一致。**macOS 26 の WebKit リグレッション**＝アプリのバグではない。上流修正なし。

**対策（確定・実装済み）**: alt-screen 切替（DECSET 47/1047/1049）を `terminal-guards.ts` で握りつぶし、
全画面TUIを通常画面で描かせる（通常画面は再描画OK）。**macOS 26 の release のときだけ**自動適用
（`sys::alt_screen_broken` → `main.ts` → `setDisableAltScreen`）。dev・旧macOS・Linux・Windows は従来どおり。

詳細レポート: `docs/2026-10-24-macos26-wkwebview-altscreen.md`。

**教訓の総括**：
- 「DOMは埋まるのに画面が出ない」は**合成/提示の問題**。`cat <file>` で「実体は編集されている」を確かめると、
  入力問題と描画問題を一瞬で切り分けられた（もっと早くやるべきだった）。
- **release でしか出ない描画バグは dev で検証しても無駄**（dev=debug は条件が違う）。実機release＋オンデバイス計測が最短。
- 最後はコードではなく**プラットフォーム（OS/WebView）側**だった。`navigator`ではなくOS/版まで疑うこと。
