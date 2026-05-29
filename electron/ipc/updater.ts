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
import fs from "node:fs";
import path from "node:path";

/**
 * `electron-updater` reads its publish/feed config from `app-update.yml`,
 * which electron-builder only emits for full distributable targets
 * (dmg/nsis/zip with a `publish` block). Local `--dir` builds (e.g.
 * `bun run electron:app`) ARE packaged — `app.isPackaged === true` — but ship
 * no `app-update.yml`, so calling `checkForUpdates()` throws
 * `ENOENT … app-update.yml` and surfaces as a permanent red "Updater error"
 * banner. Treat a packaged-but-unconfigured build like dev: there's nothing
 * to update from, so settle into `idle` instead of erroring.
 */
function hasUpdateConfig(): boolean {
  try {
    return fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  } catch {
    return false;
  }
}

// We lazy-load electron-updater inside `bootstrap()` rather than at
// module top because importing it eagerly evaluates a `MacUpdater` /
// `NsisUpdater` constructor that needs a live Electron `app` —
// importing this module under vitest (where `app` is mocked or
// unavailable) would throw. Lazy-loading also keeps the dev /
// unpackaged path cleaner since we never reach the require there.
type AutoUpdater = typeof import("electron-updater").autoUpdater;
let cachedUpdater: AutoUpdater | null = null;
function loadAutoUpdater(): AutoUpdater {
  if (cachedUpdater) return cachedUpdater;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("electron-updater") as typeof import("electron-updater");
  cachedUpdater = mod.autoUpdater;
  return cachedUpdater;
}

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
  // Defer to autoUpdater only in packaged builds that actually carry an
  // update feed config — dev/unpackaged electron has no signed binary to
  // update from, and a local `--dir` package has no `app-update.yml`.
  const packaged = app.isPackaged && hasUpdateConfig();

  ipcMain.on(TOPIC_CHECK, () => {
    if (!packaged) {
      // Dev / unpackaged builds — and packaged `--dir` builds with no
      // `app-update.yml` — have no signed binary or feed to update from.
      // Previously we broadcast `kind: "error"` here which surfaced as
      // a red "Updater error" banner across the top of the window
      // every time the renderer mounted and auto-checked. That's
      // noise — developers know the dev build can't self-update.
      // Settle into `idle` so the banner stays hidden.
      broadcast({ kind: "idle" });
      return;
    }
    bootstrap();
    loadAutoUpdater()
      .checkForUpdates()
      .catch((err) => {
        const msg = errorMessage(err);
        // Belt-and-suspenders: any "not actually updatable" packaging state
        // (missing feed config, etc.) settles to idle rather than painting a
        // red banner the user can't act on.
        if (/app-update\.yml|ENOENT/i.test(msg)) {
          broadcast({ kind: "idle" });
          return;
        }
        broadcast({ kind: "error", message: msg });
      });
  });

  ipcMain.on(TOPIC_APPLY, () => {
    if (!packaged) return;
    try {
      loadAutoUpdater().quitAndInstall();
    } catch (err) {
      broadcast({ kind: "error", message: errorMessage(err) });
    }
  });

  // Pre-attach listeners on first window so that an auto-check fired
  // by electron-updater on its own schedule still surfaces to the
  // renderer. We don't call checkForUpdates() automatically here —
  // the renderer decides when to ask. Wrapped in try/catch because
  // require("electron-updater") can throw in some packaging edge
  // cases (missing assets, broken signing) — failing softly preserves
  // the rest of the app.
  if (packaged) {
    try {
      bootstrap();
    } catch (err) {
      broadcast({ kind: "error", message: errorMessage(err) });
    }
  }
}

function bootstrap(): void {
  if (started) return;
  started = true;
  const u = loadAutoUpdater();

  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  // Logs go to the OS-specific log path; users can inspect via
  // /api/doctor or by opening the file directly.
  u.logger = {
    info: (...args: unknown[]) => console.log("[updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[updater]", ...args),
    error: (...args: unknown[]) => console.error("[updater]", ...args),
    debug: (...args: unknown[]) => console.debug("[updater]", ...args),
  };

  u.on("checking-for-update", () => broadcast({ kind: "checking" }));
  u.on("update-available", (info) =>
    broadcast({ kind: "available", version: info.version }),
  );
  u.on("update-not-available", () => broadcast({ kind: "idle" }));
  u.on("download-progress", (p) =>
    broadcast({ kind: "downloading", percent: Math.round(p.percent) }),
  );
  u.on("update-downloaded", (info) =>
    broadcast({ kind: "downloaded", version: info.version }),
  );
  u.on("error", (err) =>
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
