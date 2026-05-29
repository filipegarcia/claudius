/**
 * Native application menu.
 *
 * Phase 3 of docs/electron-conversion/PLAN.md.
 *
 * Every menu item either:
 *   1. Calls a native API directly (window controls, dev tools, zoom).
 *   2. Sends `menu:action <actionId>` to the renderer, where the
 *      existing shortcut registry (`lib/client/shortcuts.ts`) routes
 *      it to the same handler the in-page keydown listener uses.
 *
 * The action IDs MUST match the entries in `SHORTCUT_ACTIONS` (Phase 3
 * extension) so the registry stays the single source of truth.
 */
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

/** Topic name shared with `electron/preload.ts`. */
const MENU_ACTION_TOPIC = "menu:action";

/**
 * Resolved accelerator strings keyed by shortcut-registry action id,
 * pushed from the renderer via `menu.setAccelerators(...)`. Lets a
 * remap in /settings rewrite the OS-menu accelerator for the
 * registry-dispatched items below.
 */
export type MenuAccelerators = Record<string, string>;

/**
 * Dispatch a menu action into the renderer's shortcut registry. The
 * preload's `menu.on(...)` listeners filter by `actionId`.
 */
function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send(MENU_ACTION_TOPIC, action);
}

function isMac(): boolean {
  return process.platform === "darwin";
}

/**
 * Resolve the accelerator for a registry-dispatched menu item: the
 * renderer-synced value when present, otherwise the shipped default.
 * The fallbacks below match `lib/client/shortcuts.ts` defaults so the
 * menu reads correctly during the brief window before the renderer's
 * first `setAccelerators(...)` lands (and in the unlikely event the
 * renderer never syncs).
 */
function accelFor(
  accelerators: MenuAccelerators | undefined,
  id: string,
  fallback: string,
): string {
  return accelerators?.[id] ?? fallback;
}

/**
 * Recursively flip every menu item to `registerAccelerator: false` so its
 * accelerator still SHOWS in the menu but no longer intercepts the keypress
 * — the key falls through to the renderer. Used while the /settings shortcut
 * recorder is listening, so the user can record a chord the menu owns (⌘T,
 * ⌘W, …) instead of the menu swallowing it.
 */
function unregisterAccelerators(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const next: MenuItemConstructorOptions = { ...item, registerAccelerator: false };
    if (Array.isArray(item.submenu)) next.submenu = unregisterAccelerators(item.submenu);
    return next;
  });
}

/**
 * Build the application menu and install it as the default. Call from
 * main after `app.whenReady()`, and again whenever the renderer pushes
 * a fresh accelerator map so the menu reflects the user's remaps.
 *
 * `opts.registerAccelerators === false` builds a display-only menu whose
 * accelerators don't intercept keystrokes — see `unregisterAccelerators`.
 */
export function installAppMenu(
  accelerators?: MenuAccelerators,
  opts?: { registerAccelerators?: boolean },
): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac()
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: accelFor(accelerators, "app.preferences", "Cmd+,"),
                click: () => send("app.preferences"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", accelerator: "Cmd+Q" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),

    {
      label: "&File",
      submenu: [
        {
          label: "New Tab",
          accelerator: accelFor(accelerators, "tab.new", "CommandOrControl+T"),
          click: () => send("tab.new"),
        },
        {
          label: "Open Workspace…",
          accelerator: accelFor(accelerators, "app.openWorkspace", "CommandOrControl+O"),
          click: () => send("app.openWorkspace"),
        },
        {
          label: "Reopen Closed Tab",
          accelerator: accelFor(accelerators, "tab.reopen", "CommandOrControl+Shift+T"),
          click: () => send("tab.reopen"),
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: accelFor(accelerators, "tab.close", "CommandOrControl+W"),
          click: () => send("tab.close"),
        },
        ...(isMac()
          ? []
          : ([
              { type: "separator" },
              {
                label: "Settings",
                accelerator: accelFor(accelerators, "app.preferences", "Ctrl+,"),
                click: () => send("app.preferences"),
              },
              { type: "separator" },
              { role: "quit", accelerator: "Ctrl+Q" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },

    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac()
          ? ([{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] satisfies MenuItemConstructorOptions[])
          : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] satisfies MenuItemConstructorOptions[])),
      ],
    },

    {
      label: "&View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CommandOrControl+R",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.reload();
          },
        },
        {
          label: "Force Reload",
          accelerator: "CommandOrControl+Shift+R",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.reloadIgnoringCache();
          },
        },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac() ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.toggleDevTools();
          },
        },
        { type: "separator" },
        { role: "resetZoom", accelerator: "CommandOrControl+0" },
        { role: "zoomIn", accelerator: "CommandOrControl+=" },
        { role: "zoomOut", accelerator: "CommandOrControl+-" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Command Palette…",
          accelerator: accelFor(accelerators, "nav.commandPalette", "CommandOrControl+K"),
          click: () => send("nav.commandPalette"),
        },
        {
          label: "Toggle Sidebar",
          accelerator: accelFor(accelerators, "nav.toggleSidebar", "CommandOrControl+B"),
          click: () => send("nav.toggleSidebar"),
        },
        {
          label: "Keyboard Shortcuts",
          accelerator: accelFor(accelerators, "nav.cheatsheet", "CommandOrControl+/"),
          click: () => send("nav.cheatsheet"),
        },
      ],
    },

    {
      label: "&Tab",
      submenu: [
        {
          // Fallback matches the registry default (⌘⇧→), not the old
          // ⌘⇧] — the two had drifted, so Settings/cheatsheet advertised
          // a chord the menu didn't honor.
          label: "Next Tab",
          accelerator: accelFor(accelerators, "tab.next", "CommandOrControl+Shift+Right"),
          click: () => send("tab.next"),
        },
        {
          label: "Previous Tab",
          accelerator: accelFor(accelerators, "tab.prev", "CommandOrControl+Shift+Left"),
          click: () => send("tab.prev"),
        },
        { type: "separator" },
        ...buildTabGoItems(accelerators),
        {
          label: "Last Tab",
          accelerator: accelFor(accelerators, "tab.last", "CommandOrControl+9"),
          click: () => send("tab.last"),
        },
      ],
    },

    {
      label: "&Window",
      submenu: [
        { role: "minimize", accelerator: "CommandOrControl+M" },
        ...(isMac()
          ? ([
              { role: "zoom" },
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "close", accelerator: "Alt+F4" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },

    {
      label: "&Help",
      role: "help",
      submenu: [
        {
          label: "Claudius on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/claudius-network/claudius");
          },
        },
        {
          label: "Report an issue",
          click: () => {
            void shell.openExternal("https://github.com/claudius-network/claudius/issues/new");
          },
        },
        { type: "separator" },
        {
          label: "About Claudius",
          click: async () => {
            await dialog.showMessageBox({
              type: "info",
              title: "About Claudius",
              message: "Claudius",
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];

  const finalTemplate =
    opts?.registerAccelerators === false ? unregisterAccelerators(template) : template;
  const menu = Menu.buildFromTemplate(finalTemplate);
  Menu.setApplicationMenu(menu);
}

function buildTabGoItems(accelerators?: MenuAccelerators): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (let i = 1; i <= 8; i++) {
    out.push({
      label: `Go to Tab ${i}`,
      accelerator: accelFor(accelerators, `tab.go${i}`, `CommandOrControl+${i}`),
      click: () => send(`tab.go${i}`),
    });
  }
  return out;
}
