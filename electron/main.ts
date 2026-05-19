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
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

import { installAppMenu } from "./menu";
import {
  defaultAppDir,
  startEmbeddedNextServer,
  type EmbeddedNextServer,
} from "./server";

const DEV_START_URL = process.env.ELECTRON_START_URL;
const IS_PACKAGED = app.isPackaged || process.env.CLAUDIUS_PACKAGED === "1";

let mainWindow: BrowserWindow | null = null;
let nextServer: EmbeddedNextServer | null = null;

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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    // Frameless + traffic lights — Phase 4 will fill in the matching
    // <TitleBar /> on the renderer side. For now `titleBarStyle` is
    // a no-op on win/linux; on mac the traffic lights still render.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 18, y: 18 } : undefined,
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
  win.once("ready-to-show", () => win.show());

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

  void win.loadURL(startUrl);
  return win;
}

app.whenReady().then(async () => {
  try {
    installAppMenu();
    const startUrl = await resolveStartUrl();
    mainWindow = createWindow(startUrl);

    mainWindow.on("closed", () => {
      mainWindow = null;
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
  // On macOS apps typically stay in the dock until the user explicitly
  // quits with Cmd+Q. On win/linux closing the last window quits.
  if (process.platform !== "darwin") {
    app.quit();
  }
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
