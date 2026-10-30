// Native application menu (macOS menu bar; window menu on Windows/Linux). The app
// is otherwise driven by the HTML toolbar + keyboard shortcuts — this surfaces every
// action in the native menu too (the macOS convention), including ones that would
// crowd the toolbar. Built entirely in JS via @tauri-apps/api/menu, so each item's
// handler is a plain closure and no Rust bridge is needed.
//
// Two deliberate choices:
//  1. Items are constructed explicitly (MenuItem/CheckMenuItem/PredefinedMenuItem/
//     Submenu) rather than as plain option objects, so the native item KIND (esp.
//     the checkmarks on Language/Theme/Permission) is unambiguous.
//  2. We DON'T attach accelerators to items the app already handles in its own
//     keydown listener (the Alt+… shortcuts, ⌘C/⌘V over the PTY) — a native menu
//     accelerator would preempt or double-fire them. The menu item still works on
//     click; the keyboard shortcut still works via the app. Only a brand-new binding
//     (⌘, for Settings) carries an accelerator. Copy/Paste/… come from the standard
//     predefined Edit menu, exactly as the default Tauri menu already provided.
import { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { getVersion } from "@tauri-apps/api/app";
import { t, setLang, getLang } from "./i18n";
import { getThemeId, type ThemeId } from "./theme";
import { checkForUpdates } from "./updater";

export interface MenuCtx {
  /** Apply a theme AND repaint open terminals — the same thing the Settings dialog
   *  does. Lives in the App because repainting needs the agent/terminal list. */
  setTheme(id: ThemeId): void;
}

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "default", label: "Default (Night)" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "solarized-light", label: "Solarized Light" },
  { id: "glass", label: "Glass (Mono)" },
];

const PERMS = ["auto", "normal", "bypass"] as const;

/// Build and install the native menu. Safe to call in a non-Tauri context (web
/// preview) — it just no-ops. Call again to rebuild (e.g. after a language/theme
/// change) so labels and checkmarks refresh.
export async function installAppMenu(ctx: MenuCtx): Promise<void> {
  try {
    await build(ctx);
  } catch {
    // Non-Tauri context or menu unavailable — toolbar + shortcuts still cover all.
  }
}

/// Fire the click handler of an existing toolbar button — reuses the exact action
/// (and all its side effects) the button already performs, so the menu never forks
/// behaviour from the toolbar.
const click = (id: string) => () => document.getElementById(id)?.click();

async function build(ctx: MenuCtx): Promise<void> {
  const rebuild = () => void build(ctx);
  const version = await getVersion().catch(() => "");
  const curLang = getLang();
  const curTheme = getThemeId();
  const permSel = document.getElementById("perm-mode") as HTMLSelectElement | null;
  const curPerm = permSel?.value ?? "auto";

  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  const item = (id: string, text: string, action: () => void, accelerator?: string) =>
    MenuItem.new({ id, text, action, accelerator });
  const check = (id: string, text: string, checked: boolean, action: () => void) =>
    CheckMenuItem.new({ id, text, checked, action });

  const appMenu = await Submenu.new({
    text: "AI Dev Terminal MAX",
    items: [
      await PredefinedMenuItem.new({ item: { About: { name: "AI Dev Terminal MAX", version } } }),
      await sep(),
      await item("m-check", t("updater.check"), () => void checkForUpdates({ silent: false })),
      await sep(),
      await item("m-settings", t("menu.settings"), click("btn-settings"), "CmdOrCtrl+,"),
      await sep(),
      await PredefinedMenuItem.new({ item: "Services" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: t("menu.file"),
    items: [
      await item("m-open", t("menu.openProject"), click("btn-open")),
      await item("m-clone", t("menu.cloneProject"), click("btn-clone")),
      await item("m-saves", t("menu.saves"), click("btn-saves")),
      await sep(),
      await item("m-add", t("menu.newAgent"), click("btn-add")),
      await item("m-fill", t("menu.fill"), click("btn-fill")),
    ],
  });

  const editMenu = await Submenu.new({
    text: t("menu.edit"),
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const langMenu = await Submenu.new({
    text: t("menu.language"),
    items: [
      await check("m-lang-en", "English", curLang === "en", () => {
        setLang("en");
        rebuild();
      }),
      await check("m-lang-ja", "日本語", curLang === "ja", () => {
        setLang("ja");
        rebuild();
      }),
    ],
  });

  const themeMenu = await Submenu.new({
    text: t("menu.theme"),
    items: await Promise.all(
      THEMES.map((th) =>
        check(`m-theme-${th.id}`, th.label, curTheme === th.id, () => {
          ctx.setTheme(th.id);
          rebuild();
        }),
      ),
    ),
  });

  const viewMenu = await Submenu.new({
    text: t("menu.view"),
    items: [
      await item("m-macro", t("menu.macro"), click("btn-macro")),
      await item("m-zoom", t("menu.zoom"), click("btn-zoom")),
      await item("m-layout", t("menu.layout"), click("btn-layout")),
      await sep(),
      langMenu,
      themeMenu,
      await sep(),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
    ],
  });

  const permMenu = await Submenu.new({
    text: t("menu.permission"),
    items: await Promise.all(
      PERMS.map((p) =>
        check(`m-perm-${p}`, p, curPerm === p, () => {
          if (permSel) {
            permSel.value = p;
            permSel.dispatchEvent(new Event("change"));
          }
          rebuild();
        }),
      ),
    ),
  });

  const agentMenu = await Submenu.new({
    text: t("menu.agent"),
    items: [
      await item("m-run-all", t("menu.runAll"), click("btn-run-all")),
      await item("m-send", t("menu.send"), click("btn-send")),
      await sep(),
      permMenu,
      await item("m-guard", t("menu.guard"), click("btn-guard")),
      await item("m-nest", t("menu.nest"), click("btn-nest")),
    ],
  });

  const windowMenu = await Submenu.new({
    text: t("menu.window"),
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
    ],
  });

  const helpMenu = await Submenu.new({
    text: t("help.title"),
    items: [await item("m-help", t("menu.help"), click("btn-help"))],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, agentMenu, windowMenu, helpMenu],
  });
  await menu.setAsAppMenu();
}
