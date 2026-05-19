/**
 * Auto-updater IPC bridge — Phase 7 of
 * docs/electron-conversion/PLAN.md.
 *
 * Wraps `electron-updater`'s `autoUpdater` so the renderer can:
 *   - trigger a check  (`updater:check`)
 *   - kick off the install  (`updater:apply`)
 *   - subscribe to status events  (`updater:status`)
 *
 * Status events are normalized to the `ClaudiusUpdaterStatus` union
 * defined in `lib/shared/electron.d.ts` so the existing
 * `UpdaterBanner` can reuse them without a parallel data shape.
 *
 * Configuration comes from `electron-builder.yml`'s `publish` block
 * (currently GitHub Releases) — `autoUpdater` reads it automatically
 * from the packaged app.yml.
 *
 * Notes:
 *   - This file is only loaded when running inside Electron (the
 *     server-side `lib/server/updater/*` continues to drive the web
 *     build's git-pull updater).
 *   - autoUpdater throws if you call `checkForUpdates()` in dev /
 *     unpackaged. We early-return in that case so calling check during
 *     `electron:dev` doesn't crash.
 */
import { app, BrowserWindow, ipcMain } from "electron";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

const TOPIC_CHECK = "updater:check";
const TOPIC_APPLY = "updater:apply";
const TOPIC_STATUS = "updater:status";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

let started = false;

function broadcast(status: Status): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (win.isDestroyed()) continue;
    win.webContents.send(TOPIC_STATUS, status);
  }
}

export function registerUpdaterHandlers(): void {
  // Defer to autoUpdater only in packaged builds — dev/unpackaged
  // electron has no signed binary to update from.
  const packaged = app.isPackaged;

  ipcMain.on(TOPIC_CHECK, () => {
    if (!packaged) {
      broadcast({
        kind: "error",
        message: "Updater unavailable in dev / unpackaged builds",
      });
      return;
    }
    bootstrap();
    autoUpdater.checkForUpdates().catch((err) => {
      broadcast({ kind: "error", message: errorMessage(err) });
    });
  });

  ipcMain.on(TOPIC_APPLY, () => {
    if (!packaged) return;
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      broadcast({ kind: "error", message: errorMessage(err) });
    }
  });

  // Pre-attach listeners on first window so that an auto-check fired
  // by electron-updater on its own schedule still surfaces to the
  // renderer. We don't call checkForUpdates() automatically here —
  // the renderer decides when to ask.
  if (packaged) bootstrap();
}

function bootstrap(): void {
  if (started) return;
  started = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Logs go to the OS-specific log path; users can inspect via
  // /api/doctor or by opening the file directly.
  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log("[updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[updater]", ...args),
    error: (...args: unknown[]) => console.error("[updater]", ...args),
    debug: (...args: unknown[]) => console.debug("[updater]", ...args),
  };

  autoUpdater.on("checking-for-update", () => broadcast({ kind: "checking" }));
  autoUpdater.on("update-available", (info) =>
    broadcast({ kind: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => broadcast({ kind: "idle" }));
  autoUpdater.on("download-progress", (p) =>
    broadcast({ kind: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    broadcast({ kind: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (err) =>
    broadcast({ kind: "error", message: errorMessage(err) }),
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown updater error";
  }
}
