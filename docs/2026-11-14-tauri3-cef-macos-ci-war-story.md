# Shipping a Tauri 3 + CEF (Chromium) macOS app through GitHub Actions — a CI war story

作成: 2026-11-14 / 対象: このリポジトリで macOS を CEF(Chromium) 化し、GitHub Actions の
`release.yml` で**ネイティブ arm64 の CEF リリースビルド**を緑にするまでの全記録と再利用レシピ。
関連: `docs/2026-11-12-cef-migration-plan.md`、`docs/2026-11-13-cef-performance-and-engine-strategy.md`、
`CLAUDE.md` の vim 節。

> 結論から：**v0.3.0-cef.8 で全OS 緑**（macOS ネイティブ arm64 CEF dmg ＋ Windows ＋ Linux）。
> プレリリースを **cef.1 → cef.8 の 8 回**回し、5 つの別々の根本原因を 1 つずつ潰した。
> 以下はその各原因と最終レシピ。同じ「Tauri 3 + CEF + CI」で詰まった人がそのまま使えるように書いた。

## なぜ CEF なのか（前提）
- 全画面 TUI（vim/htop/less）が **macOS 26 (Tahoe) の WKWebView** で描画が固まる
  （[wry#1848](https://github.com/tauri-apps/wry/issues/1848)、当アプリ側の不具合ではない）。
- WKWebView 固有。Windows(WebView2)/Linux(WebKitGTK) は無事。Chromium 同梱の Electron(VS Code) も無事。
- → **macOS だけ webview エンジンを CEF(Chromium) に**。Windows/Linux は wry のまま。
  ランタイムは Tauri 3 の `tauri-runtime-cef` / `tauri-runtime-wry` を `#[cfg(target_os)]` で出し分け。

## CI を緑にするまでの 5 つの壁（cef.1 → cef.8）

### 壁1: stale な `Cargo.lock`（Tauri 2 のまま）
- 症状: `tauri build` が即停止、`Found version mismatched Tauri packages: tauri (v2.12.5) : @tauri-apps/api (v3.0.0-alpha.3)`。
- 原因: `Cargo.toml`/npm を Tauri 3 にしたが、**`Cargo.lock` を再生成コミットしていなかった**。
  ローカルは cargo が lock を自動再生成するので露見しない。CI（clean checkout）だけで出る。
- 修正: `cargo generate-lockfile` → コミット。`cargo check --locked` で確認。
- 教訓: **メジャー/ランタイムを上げたら lockfile を必ず再生成・コミット**。「ローカルで通る」は CI の証明にならない。

### 壁2: 固定した macOS ランナーラベルが retired
- 症状: `macos-14` ジョブが **t=0 で即 cancel**（runner 未割当）。`macos-13` は **starve**（queue のまま）。
- 原因: **`macos-14` は 2026-11-02 に retired**、`macos-13` はさらに旧く不可。arm64/Intel の別ではなく
  **固定バージョンラベルが死んでいた**だけ。利用可能なのは **`macos-latest` ＝ macOS 26 / Apple Silicon(arm64)**。
- 修正: macOS ジョブを **`macos-latest` + `--target aarch64-apple-darwin`**（ネイティブ arm64）に。
- 教訓: **macOS ランナーは固定版でなく `macos-latest` を使う**（固定は retire で突然死ぬ）。
  retire 情報は [actions/runner-images README](https://github.com/actions/runner-images) の表で確認できる。
- 注: CEF はアーキ別バイナリなので `universal-apple-darwin` は不可。1 ジョブ 1 アーキ。

### 壁3: CEF 自動ダウンローダの ureq 10 MiB 上限
- 症状: `cef-dll-sys` の build script が `Error: HTTP request error: json: the response body is larger
  than request limit: 10485760`。
- 原因: `download-cef` が Spotify の `index.json`（全ビルド一覧、10 MiB 超）を **ureq で取得するが本文を
  10 MiB で打ち切る**。cold キャッシュで必発。ローカルが通るのは `~/Library/Caches/tauri-cef` が温まっているため。
- 修正: CI で **`curl`（上限なし）**で index を取得 → 対象アーカイブ(macosarm64, type=minimal, cef_version
  154.0.34)を自前で DL・展開し、**`CEF_PATH`** を指定 → build script の自前 DL を回避。
- 教訓: **上流の downloader が壊れていたら、依存をベンダリング（事前取得）して環境変数で差し込む**のが定石。

### 壁4: pre-provided `CEF_PATH` には `archive.json` が要る
- 症状: `CEF_PATH is invalid (failed to open .../archive.json)` → また自前 DL にフォールバック。
- 原因: `cef-dll-sys` sys/build.rs は、CEF_PATH のディレクトリに **`archive.json`**
  （`{type,name,sha1}`、名前のバージョン ≤ crate の CEF 版）が無いと「無効」と判断する。
- 修正: index のエントリから `archive.json` を生成して CEF ディレクトリに書き込む。URL は download-cef と
  同じく**生のファイル名（`+` を URL エンコードしない）**で（`format!("{url}/{file}")`）。

### 壁5: バンドラーは framework を `CEF_PATH` 直下に要求
- 症状: ビルドは**完全に成功**（`cef` crate＋ラッパーの CMake ビルドまで）するが、最後の**バンドル**で
  `CEF binary distribution not found ... (missing 'Chromium Embedded Framework.framework')`。
- 原因: 生の `cef_binary_*` 展開は framework が `Release/` の中。バンドラーは **CEF_PATH 直下**に framework を要求。
- 修正: `download-cef::extract_target_archive` の**正規レイアウト**を再現する。
  `~/cef/dist` に **`Release/` の中身をルートへ昇格**（framework がルート）＋ `include/` `libcef_dll/`
  `cmake/` `CMakeLists.txt` `CREDITS.html` を併置＋ `archive.json`。`ditto` で framework バンドルを保全。

## 最終レシピ（`release.yml` の macOS 差分）
Windows/Linux は無改変（wry のまま）。macOS ジョブにだけ以下を足す。

```yaml
# matrix（macOS は macos-latest = macOS 26 / arm64 の 1 ジョブ。universal 不可）
- platform: macos-latest
  args: "--target aarch64-apple-darwin"
  rust-targets: "aarch64-apple-darwin"

# steps（Install pnpm の前あたり、macOS のみ）
- name: Install CEF build tools (macOS)
  if: startsWith(matrix.platform, 'macos')
  run: brew install cmake ninja          # libcef_dll_wrapper を CMake/Ninja でビルド

- name: Cache CEF (macOS)
  if: startsWith(matrix.platform, 'macos')
  uses: actions/cache@v4
  with: { path: ~/cef, key: cef-macosarm64-154.0.34-minimal-v3 }

- name: Provision CEF + set CEF_PATH (macOS)
  if: startsWith(matrix.platform, 'macos')
  run: |
    set -euo pipefail
    DIST="$HOME/cef/dist"
    curl -sSL https://cef-builds.spotifycdn.com/index.json -o /tmp/cef-index.json   # ← curl で 10MiB 上限回避
    python3 -c "import json; d=json.load(open('/tmp/cef-index.json')); vs=[v for v in d['macosarm64']['versions'] if v['cef_version'].startswith('154.0.34+')]; assert vs; fs=[f for f in vs[0]['files'] if f['type']=='minimal'] or [f for f in vs[0]['files'] if f['type']=='standard']; f=fs[0]; open('/tmp/cef-url','w').write('https://cef-builds.spotifycdn.com/'+f['name']); open('/tmp/cef-archive.json','w').write(json.dumps({'type':f['type'],'name':f['name'],'sha1':f['sha1']}))"
    if [ ! -d "$DIST/Chromium Embedded Framework.framework" ]; then
      rm -rf "$HOME/cef/extract" "$DIST"; mkdir -p "$HOME/cef/extract" "$DIST"
      curl -sSL "$(cat /tmp/cef-url)" -o /tmp/cef.tar.bz2
      tar -xjf /tmp/cef.tar.bz2 -C "$HOME/cef/extract"
      SRC="$(find "$HOME/cef/extract" -maxdepth 1 -type d -name 'cef_binary_*' | head -1)"
      ditto "$SRC/Release" "$DIST"                      # ← Release/ の中身をルートへ（framework がルート）
      ditto "$SRC/include" "$DIST/include"
      ditto "$SRC/libcef_dll" "$DIST/libcef_dll"
      ditto "$SRC/cmake" "$DIST/cmake"
      cp "$SRC/CMakeLists.txt" "$DIST/"; cp "$SRC/CREDITS.html" "$DIST/" 2>/dev/null || true
    fi
    cp /tmp/cef-archive.json "$DIST/archive.json"       # ← build script が CEF_PATH を受理する鍵
    echo "CEF_PATH=$DIST" >> "$GITHUB_ENV"
```
※ バージョン(`154.0.34` / cef-dll-sys `154.5.0`)は `tauri-runtime-cef` の更新で変わる。Cargo.lock の
`cef-dll-sys` を確認してキー/フィルタを合わせる。

## 横断的な教訓
1. **lockfile はツールチェーン更新のたび再生成コミット**。「ローカルで通る」は CI の証明にならない。
2. **CI の macOS ランナーは `macos-latest`**。固定版は retire で突然死ぬ。[runner-images] の表を見る。
3. **上流の自動ダウンローダが脆い（巨大 JSON / 特殊キャッシュ）なら、依存を自前取得して環境変数で差し込む**。
   その際、上流が期待する**正確なレイアウト/メタファイル**（ここでは `archive.json` と Release/ 昇格）を
   ソースから読んで再現する（`tauri-apps/cef-rs` の `download-cef` / `sys/build.rs`）。
4. **CI 固有のバグは実機 CI でしか出ない**。この Linux 開発環境では macOS CEF を試せないので、
   プレリリースタグで小さく回して実エラーで詰めた（8 回）。各回で 1 原因に絞ると速い。
5. **緑は段階的に奥へ進む**：即死(壁1) → ランナー(壁2) → DL(壁3) → メタ(壁4) → バンドル(壁5)。
   「前回より後段で落ちた」は前進のサイン。

## 参照
- 上流ソース（レイアウト/メタの真実）: `tauri-apps/cef-rs` → `download-cef/src/lib.rs`
  (`extract_target_archive`, `check_archive_json`, `CefFile`)、`sys/build.rs`（CEF_PATH の扱い）。
- CEF 配布: https://cef-builds.spotifycdn.com/index.json （ureq では 10MiB 超で死ぬ巨大 JSON）。
- runner retire: https://github.com/actions/runner-images
- Tauri v3 CEF: https://v3.tauri.app/develop/cef/
