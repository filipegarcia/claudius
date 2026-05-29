/**
 * Dock / taskbar unread badge — Phase 6 of
 * docs/electron-conversion/PLAN.md.
 *
 * The renderer's `useFaviconBadge` already updates the in-page
 * favicon + document.title. When running inside Electron we also push
 * the count to the OS so the dock (macOS) / taskbar (Windows / Linux)
 * surfaces unread state when the window isn't focused.
 *
 * Per-platform implementation:
 *   - mac:   `app.setBadgeCount(n)` — natively renders the red bubble.
 *   - win:   `BrowserWindow.setOverlayIcon(...)` — we paint a tiny
 *            icon on top of the taskbar entry. The icon itself is
 *            cached in the resources dir; for v1 we use a flat red
 *            dot so it's visible across themes.
 *   - linux: `app.setBadgeCount(n)` first (Unity launcher), then fall
 *            back to a window flash if that's a no-op. Neither is
 *            universally supported across X11/Wayland desktops, so
 *            this is best-effort.
 */
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";

const TOPIC_SET = "badge:set";

// 12x12 red dot used as the Windows taskbar overlay. Encoded as a
// base64 PNG so we don't have to ship a separate asset file. Created
// once at module load.
const DOT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAAQ0lEQVQYV2NgYGD4z0AB+M9AAcDAQI2BAfYgC8gBaJgFEAhCEgQA5wY+ZBHYIAQO4M8jzEGQAxQA2EaYAyHCDwAA9hAGAdGdNcMAAAAASUVORK5CYII=";

let overlayIconCache: Electron.NativeImage | null = null;

function getOverlayIcon(): Electron.NativeImage {
  if (overlayIconCache) return overlayIconCache;
  overlayIconCache = nativeImage.createFromBuffer(
    Buffer.from(DOT_PNG_BASE64, "base64"),
  );
  return overlayIconCache;
}

/**
 * Register the badge IPC handler. Call once from `main.ts` after
 * `app.whenReady()`.
 */
export function registerBadgeHandlers(): void {
  ipcMain.on(TOPIC_SET, (event, raw: unknown) => {
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    const win =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getAllWindows()[0] ??
      null;

    try {
      if (process.platform === "darwin" || process.platform === "linux") {
        // Mac shows the bubble natively on the dock; Linux's Unity
        // launcher honours this best-effort.
        app.setBadgeCount(n);
      }

      if (process.platform === "win32" && win) {
        if (n > 0) {
          win.setOverlayIcon(getOverlayIcon(), `${n} unread`);
        } else {
          win.setOverlayIcon(null, "");
        }
      }
    } catch (err) {
      console.error("[electron/badge] set failed:", err);
    }
  });
}
