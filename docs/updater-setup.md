# 自動アップデート セットアップ手順（Tauri 2 updater）

アプリ側の実装（プラグイン・設定・UI・CI）は**済み**です。残りは **署名鍵の用意**だけ。
鍵が無いと `bundle.createUpdaterArtifacts=true` のため**リリースビルドが失敗**するので、
**次のリリース（v0.1.5）を出す前に**この手順を終わらせてください。

## 仕組み（概要）
- 各リリースに tauri-action が **署名済みアップデータ成果物＋`latest.json`** を自動添付。
- アプリは起動4秒後に**静かに更新確認**（更新があればダイアログ）＋ **Alt+U** で手動確認。
- 更新を承認 → ダウンロード（署名検証）→ 自動再起動。
- エンドポイント: `https://github.com/foresthill/ai-development-terminal-max/releases/latest/download/latest.json`（`tauri.conf.json`）。

## 手順

### ① 署名鍵を生成（自分のMacで一度だけ）
```bash
pnpm tauri signer generate -w ~/.tauri/aidt-updater.key
```
- パスワードを聞かれるので設定（空でも可だが設定推奨）。
- 出力される **public key**（長いbase64）をコピー。秘密鍵は `~/.tauri/aidt-updater.key` に保存される。
- **秘密鍵・パスワードは絶対にコミットしない／共有しない。**

### ② 公開鍵を `tauri.conf.json` に貼る
`src-tauri/tauri.conf.json` の：
```json
"updater": { "pubkey": "REPLACE_WITH_YOUR_UPDATER_PUBLIC_KEY", ... }
```
の `REPLACE_WITH_YOUR_UPDATER_PUBLIC_KEY` を **①の public key** に置換してコミット。

### ③ GitHub の Secrets に秘密鍵を登録
リポジトリ → Settings → Secrets and variables → Actions → **New repository secret**：
- `TAURI_SIGNING_PRIVATE_KEY` = `~/.tauri/aidt-updater.key` の**中身**（ファイル全体のbase64文字列）
  ```bash
  cat ~/.tauri/aidt-updater.key   # これを丸ごと貼る
  ```
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = ①で設定したパスワード（空なら空のsecret）

### ④ リリースを出す
`git tag v0.1.5 origin/main && git push origin v0.1.5`（いつもの流れ）。
tauri-action が署名して `latest.json` を添付します。

## 注意
- **古いバージョン（v0.1.4 以前）は updater を持たないので、そこからは自動更新されません。** v0.1.5 以降のバージョン間で自動更新が効きます（社長には一度 v0.1.5 を手動で入れてもらえば、以後は自動）。
- これは **updater 用の署名**で、**Apple の Gatekeeper 署名（Developer ID）とは別物**。Gatekeeper の初回警告は未署名のままなら残ります（自動更新自体は動く）。
- Windows の `installMode` は `passive`（進捗を見せて自動インストール）。変更可。

## 実装の場所（参考）
- Rust: `src-tauri/Cargo.toml`（updater/process）, `src-tauri/src/lib.rs`（プラグイン登録）, `src-tauri/capabilities/default.json`（権限）
- 設定: `src-tauri/tauri.conf.json`（`createUpdaterArtifacts` / `plugins.updater`）
- フロント: `src/updater.ts`（check→確認→DL→relaunch）, `src/app.ts`（起動時チェック＋Alt+U）
- CI: `.github/workflows/release.yml`（署名env）

参考: [公式 Updater プラグイン](https://v2.tauri.app/plugin/updater/) / [GitHubパイプライン](https://v2.tauri.app/distribute/pipelines/github/)
