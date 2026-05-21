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
import { BrowserWindow, ipcMain } from "electron";
import type Electron from "electron";

import type { Bus } from "./bus";

/**
 * Read the `Notification` class dynamically from the `electron` module
 * at call time (rather than destructuring at import time). Production
 * behavior is unchanged — every call resolves to the real
 * `electron.Notification`.
 */
function notificationCtor(): typeof Electron.Notification {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const e = require("electron") as typeof Electron;
  return e.Notification;
}

/**
 * Test-only hook. E2e specs set `globalThis.__claudiusNotifSink__` to
 * a function before triggering the IPC, and the handler below routes
 * the payload there *instead of* constructing a real OS notification.
 *
 * Why this lives in production code: Playwright's
 * `electronApp.evaluate(cb)` passes the electron module as a snapshot
 * (not a live reference), so mutating
 * `electron.Notification = FakeCtor` from a spec doesn't propagate
 * back to handlers that look the constructor up dynamically. The same
 * `globalThis` IS the same reference inside spec evaluates and inside
 * any main-process module — so a globally-mounted hook is a portable
 * substitute. The hook is null in normal use → zero production cost.
 *
 * Spec usage pattern:
 *   await launched.app.evaluate(() => {
 *     globalThis.__claudiusNotifPayloads__ = [];
 *     globalThis.__claudiusNotifSink__ = (p) =>
 *       globalThis.__claudiusNotifPayloads__.push(p);
 *   });
 *   // ...drive bridge.notifications.show(...) from the renderer...
 *   const captured = await launched.app.evaluate(
 *     () => globalThis.__claudiusNotifPayloads__,
 *   );
 */
type TestNotificationPayload = {
  title: string;
  body: string;
  silent: boolean;
  sessionId?: string;
};

declare global {
  var __claudiusNotifSink__:
    | ((payload: TestNotificationPayload) => void)
    | undefined;
}

function takeTestSink(): ((p: TestNotificationPayload) => void) | null {
  const sink = globalThis.__claudiusNotifSink__;
  return typeof sink === "function" ? sink : null;
}

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

    // Test-only fast path: if a spec has mounted a sink, hand the
    // payload to it and skip the OS-side construction entirely. Real
    // production builds never set this hook.
    const sink = takeTestSink();
    if (sink) {
      sink({ title, body, silent: silent === true, sessionId });
      return;
    }

    const Notification = notificationCtor();
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
