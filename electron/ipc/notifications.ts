/**
 * OS notification handler — Phase 6 of
 * docs/electron-conversion/PLAN.md.
 *
 * The renderer's `useNotifications` hook calls `window.claudius
 * .notifications.show({ title, body, sessionId })` for events that
 * arrive while `document.hidden` is true. The preload forwards this
 * to the `notification:show` IPC topic; the handler here builds a
 * native `Notification` (Electron-side, NOT Chromium-side) and on
 * click:
 *   1. Brings the BrowserWindow to the foreground (`show()` +
 *      `focus()`).
 *   2. Sends `notification:click <sessionId>` back to the renderer so
 *      `useElectronSubscription(bridge.notifications.onClick, …)` can
 *      route into `switchSession(sessionId)`.
 *
 * Why Electron-side notifications (not the renderer's `new
 * Notification(...)`)?
 *   - The renderer's `window.focus()` is unreliable when the
 *     BrowserWindow is hidden or behind other apps; only main can
 *     reliably raise it.
 *   - Notifications outlive the renderer process (if the renderer
 *     reloads, the OS toast stays); the main-side handler keeps a
 *     weak map so a click after a reload still works.
 */
import { BrowserWindow, Notification, ipcMain } from "electron";

import type { Bus } from "./bus";

const TOPIC_SHOW = "notification:show";
const TOPIC_CLICK = "notification:click";

type ShowPayload = {
  title: string;
  body: string;
  sessionId?: string;
  silent?: boolean;
};

/**
 * Register the notification IPC handlers. Call once from `main.ts`
 * after `app.whenReady()`.
 */
export function registerNotificationHandlers(bus: Bus): void {
  ipcMain.on(TOPIC_SHOW, (event, raw: ShowPayload | undefined) => {
    if (!raw || typeof raw !== "object") return;
    const { title, body, sessionId, silent } = raw;
    if (typeof title !== "string" || typeof body !== "string") return;
    if (!Notification.isSupported()) {
      // Best-effort — log so we know the platform is missing the API.
      console.warn("[electron/notifications] OS notifications not supported");
      return;
    }
    try {
      const notif = new Notification({
        title,
        body,
        silent: silent === true,
      });
      notif.on("click", () => {
        const win =
          BrowserWindow.fromWebContents(event.sender) ??
          BrowserWindow.getAllWindows()[0] ??
          null;
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          // Phase 4 frameless chrome doesn't auto-show, so we belt-and-
          // braces here.
          win.webContents.send(TOPIC_CLICK, sessionId);
        } else {
          // Fall back to the shared bus if no window is alive; the
          // renderer might pick it up on next mount.
          bus.publish(TOPIC_CLICK, sessionId);
        }
      });
      notif.show();
    } catch (err) {
      console.error("[electron/notifications] show failed:", err);
    }
  });
}
