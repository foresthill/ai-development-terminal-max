# Releasing

AI Dev Terminal MAX ships as native installers for **macOS, Windows and Linux**,
built by GitHub Actions (`.github/workflows/release.yml`). Tauri can't
cross-compile, so each OS is built on its own runner — you don't need three
machines.

## Cut a release

1. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`
   (keep them in sync), commit, and merge to `main`.
2. Tag the release and push the tag:
   ```bash
   git checkout main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The `release` workflow builds all three platforms and creates a **draft**
   GitHub Release with the installers attached.
4. Open the draft under **Releases**, check the assets, edit the notes, and
   click **Publish**.

You can also trigger the workflow by hand (Actions → release → *Run workflow*)
to dry-run it — that produces a draft you can delete.

## What gets built

| OS | Artifacts |
|----|-----------|
| macOS | `.dmg` + `.app` (universal — Apple Silicon **and** Intel) |
| Windows | `.msi` and NSIS `.exe` |
| Linux | `.AppImage`, `.deb`, `.rpm` |

## Signing (optional)

The build is **unsigned** unless signing secrets are set. Unsigned is fine for
sharing, but users see a one-time prompt:

- **macOS** — Gatekeeper "cannot verify the developer". Right-click the app →
  **Open** → **Open** (only needed once).
- **Windows** — SmartScreen "Windows protected your PC". **More info** → **Run
  anyway**.

To remove the prompts, add these repository secrets (Settings → Secrets and
variables → Actions). The workflow already reads them — no edits needed.

**macOS** (needs an Apple Developer account + a *Developer ID Application*
certificate, and notarization):

- `APPLE_CERTIFICATE` — base64 of the exported `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — the `.p12` password
- `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`

> Note: an Apple Developer enrollment covers macOS too, but you specifically
> need a **Developer ID Application** certificate to distribute a `.app` outside
> the Mac App Store.

**Windows** needs a code-signing certificate (from a CA). Configure it under
`bundle.windows` in `tauri.conf.json` and add the matching secrets; until then
Windows builds stay unsigned.
