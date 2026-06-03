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
 * "Press ⌘Q again to quit" double-press window, in ms.
 *
 * Keep in lockstep with `QUIT_WARNING_MS` in
 * `components/chrome/QuitWarningToast.tsx` — the renderer auto-hides
 * the HUD after this same horizon, so the visual state and the main
 * process's arming state stay in sync.
 *
 * We intercept Cmd+Q (and Ctrl+Q on win/linux) at the menu-item level
 * rather than via `before-quit`. That choice is deliberate: the
 * `window-all-closed` handler in `electron/main.ts` calls `app.quit()`
 * to terminate the embedded Next server, and a `before-quit` veto
 * would strand the process with no window left to render the warning.
 * Scoping the intercept to the explicit Quit chord leaves red-button
 * close, `app.quit()` from `window-all-closed`, and OS shutdown paths
 * working as they did before.
 */
const QUIT_WARNING_MS = 2500;

/**
 * Timestamp (`Date.now()` epoch ms) of the last unconfirmed Cmd+Q press.
 * `null` when the chord is not armed. A second press within
 * `QUIT_WARNING_MS` of this value performs the actual quit; anything
 * later re-arms with a fresh warning.
 */
let quitArmedAt: number | null = null;

/**
 * Cmd+Q / Ctrl+Q click handler. First press arms a short window and
 * tells the renderer to show the "Press again to quit" toast; second
 * press inside that window calls `app.quit()` and tears the app down.
 *
 * Uses the shared `send(...)` helper so the renderer receives the HUD
 * ping on the same `menu:action` channel it already subscribes to via
 * `useElectronAction("app.quitWarning", ...)` — no preload changes.
 */
function handleQuitChord(): void {
  const now = Date.now();
  if (quitArmedAt !== null && now - quitArmedAt <= QUIT_WARNING_MS) {
    // Confirmed — fall through to a real quit. Clear the flag so an
    // aborted shutdown (somebody else preventDefaults the upcoming
    // `before-quit`) doesn't leave the chord pre-armed.
    quitArmedAt = null;
    app.quit();
    return;
  }
  quitArmedAt = now;
  send("app.quitWarning");
  // Re-disarm after the warning window so a much-later press starts
  // fresh instead of accidentally confirming.
  setTimeout(() => {
    if (quitArmedAt !== null && Date.now() - quitArmedAt >= QUIT_WARNING_MS) {
      quitArmedAt = null;
    }
  }, QUIT_WARNING_MS + 100);
}

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
              // Custom intercept — see `handleQuitChord`. First press
              // shows a "press again to quit" HUD via the renderer; a
              // second press inside the QUIT_WARNING_MS window
              // performs the actual `app.quit()`. We deliberately do
              // NOT use `role: "quit"` here, because that bypasses our
              // click handler entirely.
              {
                label: "Quit Claudius",
                accelerator: "Cmd+Q",
                click: handleQuitChord,
              },
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
              // Mirror the macOS intercept on win/linux so Ctrl+Q
              // surfaces the same "press again to quit" HUD instead
              // of an immediate teardown.
              {
                label: "Quit Claudius",
                accelerator: "Ctrl+Q",
                click: handleQuitChord,
              },
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
          // Fallback matches the registry default (⌘⌥→). ⌘⌥ rather than
          // ⌘⇧ so the chord doesn't shadow macOS's Shift+Arrow text
          // selection in the composer / any input.
          label: "Next Tab",
          accelerator: accelFor(accelerators, "tab.next", "CommandOrControl+Alt+Right"),
          click: () => send("tab.next"),
        },
        {
          label: "Previous Tab",
          accelerator: accelFor(accelerators, "tab.prev", "CommandOrControl+Alt+Left"),
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
            void shell.openExternal("https://github.com/filipegarcia/claudius");
          },
        },
        {
          label: "Report an issue",
          click: () => {
            void shell.openExternal("https://github.com/filipegarcia/claudius/issues/new");
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
