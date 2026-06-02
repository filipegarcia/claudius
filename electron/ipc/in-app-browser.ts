/**
 * In-app browser viewer for external links.
 *
 * When the user has set `Settings → Link target` to "in-app viewer",
 * `setWindowOpenHandler` in `electron/main.ts` calls `openInAppBrowser(url)`
 * instead of `shell.openExternal(url)`. We open a NEW `BrowserWindow` that
 * is deliberately isolated from the Claudius renderer:
 *
 *   - No preload script (`window.claudius` MUST be undefined inside the
 *     viewer — the website is untrusted web content; handing it the IPC
 *     bridge would defeat contextIsolation).
 *   - A dedicated `session` partition (`persist:in-app-viewer`) so cookies
 *     and storage from external sites never co-mingle with the main
 *     Claudius session.
 *   - Standard OS chrome (title bar, traffic lights). Frameless styling
 *     belongs to Claudius's branded UI; viewer windows look like normal
 *     browser windows so the user can't confuse them with the app.
 *   - Recursive `setWindowOpenHandler` so a link clicked INSIDE the viewer
 *     opens another viewer window (instead of leaking into the app's
 *     handler or escaping to Chromium's defaults).
 *
 * One new window per call — we don't try to maintain a single "preview"
 * window that gets reused, both because that adds session-state bookkeeping
 * and because users with multiple monitors actively want side-by-side
 * windows. Closing a viewer is just Cmd+W.
 *
 * V1 scope: separate-window viewer. An embedded-tab `WebContentsView` mode
 * is the natural follow-up if the workflow demands it.
 */
import {
  BrowserWindow,
  shell,
  session as sessionApi,
  type Session,
} from "electron";

import { getLinkTarget, isHttpUrl } from "./link-target";

/** Lazily-created so we don't pay the cost when the user keeps "external". */
let viewerSession: Session | null = null;

function getViewerSession(): Session {
  if (viewerSession) return viewerSession;
  // `persist:` prefix keeps cookies across launches but in a NAMED partition
  // separate from the renderer's default. If you ever want to nuke the
  // viewer's state, `viewerSession.clearStorageData()` reaches only this
  // partition, not the main app session.
  viewerSession = sessionApi.fromPartition("persist:in-app-viewer");
  return viewerSession;
}

/**
 * Open `url` in a fresh sandboxed BrowserWindow. Returns the window so
 * callers (currently the window-open handler in main) can branch on
 * whether creation succeeded; null is returned for unsupported schemes
 * so the caller falls back to `shell.openExternal`.
 */
export function openInAppBrowser(url: string): BrowserWindow | null {
  if (!isHttpUrl(url)) return null;

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    // Standard OS chrome — frameless / hiddenInset is a Claudius brand
    // detail. Web content should look like a generic browser window.
    // No `titleBarStyle`, no `trafficLightPosition`, no `titleBarOverlay`.
    backgroundColor: "#ffffff",
    show: false,
    title: url,
    webPreferences: {
      // CRITICAL: no preload. The viewer hosts untrusted web content.
      // `window.claudius` is undefined here, which is the point.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Dedicated session so cookies/localStorage from external sites
      // don't bleed into the main app session.
      session: getViewerSession(),
      // No `spellcheck` — defaults are fine here; the viewer doesn't host
      // a chat composer.
    },
  });

  // Reflect navigations in the window title so the user can tell tabs apart.
  win.webContents.on("page-title-updated", (_event, title) => {
    if (title && title.length > 0) win.setTitle(title);
  });
  win.webContents.on("did-navigate", (_event, navigatedUrl) => {
    // Keep the URL as a fallback title for sites that don't set a <title>.
    if (!win.getTitle() || win.getTitle() === url) win.setTitle(navigatedUrl);
  });

  // Recursive policy: respect the user's CURRENT preference per click.
  // If they've switched back to "Default browser" since opening this
  // viewer, links inside the viewer should also escape to the OS browser
  // — the alternative (keep sticky-in-app forever once a viewer is open)
  // surprises users who don't realise an old viewer window is hijacking
  // their clicks. Non-http schemes always go to the OS handler.
  win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
    if (!isHttpUrl(childUrl)) {
      void shell.openExternal(childUrl).catch(() => {
        // best-effort
      });
      return { action: "deny" };
    }
    if (getLinkTarget() === "in-app") {
      openInAppBrowser(childUrl);
    } else {
      void shell.openExternal(childUrl).catch(() => {
        // best-effort
      });
    }
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  void win.loadURL(url).catch((err) => {
    console.error("[electron/in-app-browser] loadURL failed:", err);
  });

  return win;
}
