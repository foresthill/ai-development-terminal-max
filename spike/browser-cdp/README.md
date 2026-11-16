# spike/browser-cdp — 方式A (detect user's Chrome + CDP drive) proof

Validates the mechanism behind the planned in-app browser upgrade
(`docs/2026-09-27-browser-controller-design.md`, 案C / 方式A) **before** any Tauri
build — the same way `spike/cef` proved the CEF engine swap before the migration.

## What it proves

`node spike/browser-cdp/cdp-spike.cjs` runs the full 方式A loop end to end:

1. **detectChrome()** — per-OS candidate paths (Chrome / Chromium / Edge / Brave). No
   bundled browser: zero added app size (this is why 方式A was chosen for C1).
2. **Launch external browser** with `--remote-debugging-port` (headed on a real desktop;
   `--headless=new` here because the sandbox has no display).
3. **connectOverCDP** — *attach* to the already-running browser (not Playwright-launch).
4. **navigate**.
5. **AX tree** via `locator.ariaSnapshot()` — a compact role/name YAML, the token-light,
   coordinate-free tree to hand an AI (Playwright's current accessibility API; the old
   `page.accessibility.snapshot()` is gone).
6. **AI actions** — `fill()` a field + `click()` a button by role/name, read the result.
7. **screenshot** — one frame, standing in for C2's `Page.startScreencast` → `<canvas>`.

## Result (sandbox Chromium)

```
connectOverCDP: attached ✓
navigated ✓  title: CDP spike
AX (ariaSnapshot):
  - heading "Hello" [level=1]
  - textbox "name field"
  - button "Submit"
  - paragraph: idle
action result (#out): "clicked; value=Ada"
方式A core: VALIDATED ✓
```

## How this maps to the real app

| spike step | real module |
|---|---|
| detectChrome(), launch flags | `src-tauri/src/browser.rs` (std::process spawn; no heavy CDP crate for C1) |
| connectOverCDP, navigate, ariaSnapshot, actions | `src/browser-controller.ts` (CDP over the WebSocket endpoint) + Tauri commands |
| screenshot → canvas | C2 only: `Page.startScreencast` frames → layer `<canvas>` |

**C1 (next):** `browser.rs` detects + launches headed Chrome in a new OS window and
returns the CDP endpoint; `browser-controller.ts` attaches and exposes navigate +
ariaSnapshot + click/type. Separate window first (fast), embed via screencast in C2.

Note: the only sandbox-specific bits are `--headless=new` + `--no-sandbox`; on the
user's machine we launch headed and drop `--no-sandbox`.
