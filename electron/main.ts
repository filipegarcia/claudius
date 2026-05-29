/**
 * Electron main process entry.
 *
 * Phase 1 of docs/electron-conversion/PLAN.md.
 *
 * Responsibilities (this phase):
 *  - Boot app lifecycle (single instance, ready hook, all-windows-closed).
 *  - In packaged builds, start the embedded Next.js server on loopback.
 *  - In dev builds, point the BrowserWindow at the already-running
 *    `next dev` on :3000 via `ELECTRON_START_URL`.
 *
 * Phases 2–8 will extend this with the IPC bridge, native menu, custom
 * title bar, OS notifications, auto-updater, and deep-link handling.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";

import { registerBadgeHandlers } from "./ipc/badge";
import { createBus } from "./ipc/bus";
import {
  notifyRendererReady,
  registerDeepLinkHandlers,
  registerProtocol,
} from "./ipc/deep-links";
import { registerDialogHandlers } from "./ipc/dialogs";
import { registerNotificationHandlers } from "./ipc/notifications";
import { registerUpdaterHandlers } from "./ipc/updater";
import { installAppMenu, type MenuAccelerators } from "./menu";
import {
  DEFAULT_OWNED_CHORDS,
  isOwnedChord,
  ownedChordsFromAccelerators,
} from "./owned-chords";
import {
  defaultAppDir,
  startEmbeddedNextServer,
  type EmbeddedNextServer,
} from "./server";

const DEV_START_URL = process.env.ELECTRON_START_URL;
const IS_PACKAGED = app.isPackaged || process.env.CLAUDIUS_PACKAGED === "1";

// Mark the runtime as Electron for server-side code. The embedded Next
// server (electron/server.ts) runs in THIS process (require("next")), so it
// inherits process.env — `isElectron()` in lib/shared/runtime.ts reads this
// flag to branch route handlers / lib/server. Set unconditionally and early
// so it's in place before the server boots. (In `electron:dev` the renderer
// targets an external `next dev` that doesn't inherit this, which is why
// server-side detection is packaged-only — see lib/shared/runtime.ts.)
process.env.CLAUDIUS_ELECTRON = "1";

// Brand the user-data-dir so renderer localStorage and IndexedDB land
// at `~/Library/Application Support/Claudius` instead of the default
// unbranded `Electron` directory. Without this:
//   • Multiple Electron-based apps share the same userData dir and can
//     stomp each other's localStorage (we saw a stale `synthwave`
//     theme bleed in from another Electron app's run).
//   • An e2e-test Electron launch and a `bun run electron:dev` launch
//     accumulate state in the same place, so the dev app inherits
//     whatever the last test left behind.
// `app.setName` must run before `app.whenReady()` to take effect on
// the userData / cache paths. We resolve those explicitly via
// `app.setPath` so the migration is uniform across macOS / Windows /
// Linux — `app.getPath("userData")` always returns
// `<appData>/<appName>` when the name has been set.
app.setName("Claudius");
// Brand notifications + taskbar grouping. On Windows the App User Model ID
// is required for OS notifications to show the app name/icon (rather than
// "electron.app.Electron"); on macOS notifications are attributed to the
// bundle, so a packaged build shows "Claudius" while `electron:dev` shows
// "Electron" — that's expected in dev and resolves once packaged.
app.setAppUserModelId("network.claudius.desktop");
// Only force-override userData when the launcher didn't pass an
// explicit `--user-data-dir` Chromium switch. The Playwright e2e
// launcher (`tests/electron/launch.ts`) relies on the switch to give
// each test run its own throwaway profile — without this guard our
// `app.setPath("userData", …)` would clobber it and every e2e Electron
// would land back in `~/Library/Application Support/Claudius`,
// re-triggering the single-instance lock against any user-launched
// dev build.
const userDataOverride = process.argv.some((a) => a.startsWith("--user-data-dir="));
if (!userDataOverride) {
  const dataRoot = path.join(app.getPath("appData"), "Claudius");
  app.setPath("userData", dataRoot);
}

let mainWindow: BrowserWindow | null = null;
let nextServer: EmbeddedNextServer | null = null;

// ── Reserved-chord ownership (Phase 3 of docs/electron-conversion/PLAN.md) ──
//
// `before-input-event` (installed per-window in `createWindow`) swallows the
// chords the app owns so Chromium's built-ins (Cmd+R reload, Cmd+W close, …)
// don't fire alongside the menu accelerator. The matching logic lives in
// `./owned-chords` (pure + unit-tested — `before-input-event` itself can't be
// driven from Playwright, since CDP-injected keys bypass it). The set is
// rebuilt from the accelerator map the renderer pushes via
// `menu.setAccelerators(...)`, so a remap in /settings keeps the swallow set
// in lockstep with the menu. The seed mirrors the shipped defaults so
// cold-start (before the first renderer sync) behaves.
let ownedChords: ReadonlySet<string> = DEFAULT_OWNED_CHORDS;

// Last accelerator map the renderer pushed — kept so we can rebuild the menu
// (e.g. to toggle recording mode) without waiting for another sync.
let lastAccelerators: MenuAccelerators | undefined;
// True while the /settings shortcut recorder is listening: the menu is rebuilt
// display-only (accelerators don't intercept) and `before-input-event` stops
// swallowing, so the chord the user presses reaches the recorder instead of
// firing the menu item it's currently bound to.
let recordingShortcut = false;

// Single-instance lock. A second invocation focuses the existing
// window instead of starting a second copy of the embedded Next
// server (which would fight over the SQLite WAL).
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Register the `claudius://` protocol as early as possible — before
// `whenReady` so cold-start URLs aren't lost. Phase 8 of
// docs/electron-conversion/PLAN.md.
registerProtocol();

// Phase 8 follow-up: dock-drop folder support. mac fires this when
// the user drops a folder on the Claudius dock icon; the path is the
// absolute fs location and routes via `workspace:open-folder` so the
// renderer can POST it to `/api/workspaces`.
const pendingDroppedFolders: string[] = [];
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("workspace:open-folder", filePath);
  } else {
    pendingDroppedFolders.push(filePath);
  }
});

async function resolveStartUrl(): Promise<string> {
  // Dev: a `next dev` is already running on :3000. The concurrently
  // pipeline in `bun run electron:dev` set ELECTRON_START_URL before
  // launching us.
  if (DEV_START_URL && !IS_PACKAGED) {
    return DEV_START_URL;
  }

  // Packaged: spin up the embedded Next server on a random loopback
  // port.
  nextServer = await startEmbeddedNextServer(defaultAppDir());
  return nextServer.url;
}

function createWindow(startUrl: string): BrowserWindow {
  // Platform variants for the frameless chrome — Phase 4 of
  // docs/electron-conversion/PLAN.md. The renderer-side <TitleBar />
  // component fills in the matching custom chrome (32px tall, drag
  // region everywhere except the win/linux traffic-light buttons).
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: !isMac && !isWindows, // mac + win = frameless; linux keeps native frame as a fallback
    titleBarStyle: isMac ? "hiddenInset" : isWindows ? "hidden" : "default",
    // Mac: traffic lights centered in the 32px title bar (matches
    // TITLE_BAR_HEIGHT in components/chrome/TitleBar.tsx).
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    // Windows: render the OS-provided minimize/maximize/close overlay
    // on top of our title bar. Renderer's TrafficLights component
    // also draws fallback buttons so the chord still works if the
    // overlay misbehaves.
    titleBarOverlay: isWindows
      ? { color: "#0a0a0a", symbolColor: "#cccccc", height: 32 }
      : undefined,
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Don't preload heavy modules in the renderer; everything goes
      // through HTTP to the embedded server, not direct Node APIs.
    },
  });

  // Don't paint until the document is ready — avoids the white-flash
  // on the dark theme.
  win.once("ready-to-show", () => {
    win.show();
    // Optional auto-open DevTools. Off by default — the dev loop
    // (`bun run electron:dev` / `make electron`) shouldn't shove a
    // separate window in the user's face. Set `CLAUDIUS_DEVTOOLS=1`
    // when you actually want it (e.g. diagnosing a renderer crash).
    // The "Toggle Developer Tools" menu item (Cmd+Opt+I) remains the
    // canonical way to open the panel on demand.
    if (!IS_PACKAGED && process.env.CLAUDIUS_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  });

  // External links open in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url).catch(() => {
      // Best-effort; nothing actionable if it fails.
    });
    return { action: "deny" };
  });

  // Phase 3 of docs/electron-conversion/PLAN.md — intercept the browser-
  // reserved chords (Cmd+T / Cmd+W / Cmd+Shift+T / Cmd+1..9 / Cmd+R /
  // Cmd+Q) before Chromium sees them. The OS menu already has matching
  // accelerators that dispatch into the renderer; preventDefault here
  // stops Chromium's own handlers (e.g. Cmd+R hard-reloading the page,
  // Cmd+W trying to close the renderer with no menu confirmation) from
  // firing alongside.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // While the recorder is listening, let every chord through so it can be
    // captured (the menu is display-only in this mode too).
    if (recordingShortcut) return;
    if (!(input.meta || input.control)) return;
    // Match the FULL chord (`code`-derived token + shift/alt) so we swallow
    // ⌘⇧→ (tab.next) without eating ⌘→ (composer line-nav), and stay
    // layout-independent — leaving copy/paste, text-field shortcuts, and
    // devtools toggles to Chromium. See `./owned-chords`.
    if (!isOwnedChord(ownedChords, input)) return;
    event.preventDefault();
  });

  void win.loadURL(startUrl);
  return win;
}

app.whenReady().then(async () => {
  try {
    installAppMenu();
    // Phase 3 follow-up — the renderer pushes its resolved shortcut
    // bindings (as Electron accelerators) so the native menu reflects the
    // user's remaps from /settings. Rebuild the menu and re-derive the
    // before-input-event owned set whenever a fresh map arrives.
    ipcMain.on("menu:set-accelerators", (_evt, accelerators: unknown) => {
      if (!accelerators || typeof accelerators !== "object") return;
      const map = accelerators as MenuAccelerators;
      lastAccelerators = map;
      installAppMenu(map, { registerAccelerators: !recordingShortcut });
      ownedChords = ownedChordsFromAccelerators(map);
    });
    // The /settings recorder toggles this: while listening, rebuild the menu
    // display-only so the user can record a chord the menu owns (⌘T, ⌘W, …)
    // instead of the accelerator swallowing it. `before-input-event` also
    // checks `recordingShortcut` and stops swallowing.
    ipcMain.on("menu:set-recording", (_evt, enabled: unknown) => {
      recordingShortcut = Boolean(enabled);
      installAppMenu(lastAccelerators, { registerAccelerators: !recordingShortcut });
    });
    // Phase 6 IPC handlers — notifications + dock/taskbar badge.
    // Register before the window opens so any early renderer message
    // (e.g. a queued badge update) has somewhere to land.
    const bus = createBus();
    registerNotificationHandlers(bus);
    registerBadgeHandlers();
    registerUpdaterHandlers();
    registerDialogHandlers();
    registerDeepLinkHandlers({
      resolveWindow: () => mainWindow,
    });
    // Phase 7 of docs/electron-conversion/PLAN.md — the packaged
    // build's auto-updater is owned by Electron; tell the embedded
    // Next process to skip its own git-pull updater so we don't have
    // two paths trying to rewrite the install at once.
    if (IS_PACKAGED) process.env.CLAUDIUS_UPDATER_DISABLED = "1";
    const startUrl = await resolveStartUrl();
    mainWindow = createWindow(startUrl);

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    // Flush any queued cold-start deep links once the renderer has
    // mounted its preload listeners. `did-finish-load` is the earliest
    // safe moment — `did-frame-finish-load` fires too early in some
    // packaged builds and the event is missed.
    mainWindow.webContents.once("did-finish-load", () => {
      notifyRendererReady();
      // Flush any folder drops that arrived before the window existed.
      const wc = mainWindow?.webContents;
      if (wc) {
        const queue = pendingDroppedFolders.splice(0);
        for (const p of queue) wc.send("workspace:open-folder", p);
      }
    });

    // macOS: re-create a window when the dock icon is clicked and
    // there are no other windows open.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
        void resolveStartUrl().then((url) => {
          mainWindow = createWindow(url);
        });
      }
    });
  } catch (err) {
    console.error("[electron/main] failed to start:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // Quit the whole app when the last window closes — same behavior
  // on every platform. Originally we honored the macOS convention
  // (stay in the dock with no windows; Cmd+Q quits explicitly), but
  // users running a single-window app like Claudius reasonably expect
  // the red close button to *actually* close the process. Keeping the
  // process alive in the background also leaves the embedded Next
  // server running, which is confusing in dev (port 3000 stays bound
  // after the window is gone).
  app.quit();
});

app.on("before-quit", async () => {
  if (nextServer) {
    try {
      await nextServer.close();
    } catch {
      // Ignore — we're tearing down anyway.
    }
    nextServer = null;
  }
});
