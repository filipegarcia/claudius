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
 * Build the application menu and install it as the default. Call
 * exactly once from main, after `app.whenReady()`.
 */
export function installAppMenu(): void {
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
                accelerator: "Cmd+,",
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
          accelerator: "CommandOrControl+T",
          click: () => send("tab.new"),
        },
        {
          label: "Open Workspace…",
          accelerator: "CommandOrControl+O",
          click: () => send("app.openWorkspace"),
        },
        {
          label: "Reopen Closed Tab",
          accelerator: "CommandOrControl+Shift+T",
          click: () => send("tab.reopen"),
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CommandOrControl+W",
          click: () => send("tab.close"),
        },
        ...(isMac()
          ? []
          : ([
              { type: "separator" },
              {
                label: "Settings",
                accelerator: "Ctrl+,",
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
          accelerator: "CommandOrControl+K",
          click: () => send("nav.commandPalette"),
        },
        {
          label: "Toggle Sidebar",
          accelerator: "CommandOrControl+B",
          click: () => send("nav.toggleSidebar"),
        },
        {
          label: "Keyboard Shortcuts",
          accelerator: "CommandOrControl+/",
          click: () => send("nav.cheatsheet"),
        },
      ],
    },

    {
      label: "&Tab",
      submenu: [
        {
          label: "Next Tab",
          accelerator: "CommandOrControl+Shift+]",
          click: () => send("tab.next"),
        },
        {
          label: "Previous Tab",
          accelerator: "CommandOrControl+Shift+[",
          click: () => send("tab.prev"),
        },
        { type: "separator" },
        ...buildTabGoItems(),
        {
          label: "Last Tab",
          accelerator: "CommandOrControl+9",
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

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function buildTabGoItems(): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (let i = 1; i <= 8; i++) {
    out.push({
      label: `Go to Tab ${i}`,
      accelerator: `CommandOrControl+${i}`,
      click: () => send(`tab.go${i}`),
    });
  }
  return out;
}
