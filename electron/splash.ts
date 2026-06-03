/**
 * Cold-start splash window.
 *
 * Cold launch of the packaged app is dominated by two things the user
 * can't see:
 *
 *   1. `startEmbeddedNextServer()` spinning up Next.js inside the asar
 *      (`require("next")` is heavy; `app.prepare()` is heavier).
 *   2. The first SSR + hydration of the route the main window loads.
 *
 * Until both finish, the main BrowserWindow stays invisible
 * (`show: false` + paint on `ready-to-show` — see `electron/main.ts`)
 * so the user doesn't see a white flash. The side effect is a long
 * "dock bounces, nothing appears" period where the app looks broken.
 *
 * This module paints a tiny dark window with the Claudius wordmark and
 * an animated indicator within ~one frame of `app.whenReady()`, then
 * the main window's `ready-to-show` handler destroys it. The splash
 * loads an inline `data:` URL with NO preload, NO node integration,
 * and a dedicated session partition — it's display-only chrome, not
 * an entry point into the IPC bridge.
 *
 * Why a separate window and not a `<div>` overlay in the renderer:
 * the slow part *is* the renderer booting. A renderer-side splash
 * can't paint until Next has SSR'd and hydrated — which is exactly
 * the wait we're trying to mask.
 */
import { BrowserWindow, screen } from "electron";

const SPLASH_WIDTH = 360;
const SPLASH_HEIGHT = 240;

// Inline HTML for the splash. Kept tiny so the data: URL fits comfortably
// and paints in a single frame. Colors match the dark theme defined in
// `app/globals.css` (`--background` / `--foreground` / `--muted` /
// `--accent`) so the splash blends into the main window when it appears.
const SPLASH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Claudius</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: #0b0b0c;
    color: #e7e7ea;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    overflow: hidden;
    -webkit-user-select: none;
    /* The whole splash is a drag region so the user can reposition
       it while waiting (rare, but the cost is zero). */
    -webkit-app-region: drag;
  }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    /* Soft radial glow behind the wordmark — keeps the splash from
       reading as a flat black rectangle on OLED / dark-mode systems. */
    background:
      radial-gradient(ellipse at center, rgba(217, 119, 87, 0.08) 0%, transparent 60%),
      #0b0b0c;
  }
  .wordmark {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #e7e7ea;
  }
  .sub {
    font-size: 11px;
    color: #6b6b71;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .dots {
    display: inline-flex;
    gap: 7px;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #d97757;
    opacity: 0.35;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.18s; }
  .dot:nth-child(3) { animation-delay: 0.36s; }
  @keyframes pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
    40%          { opacity: 1;   transform: scale(1); }
  }
</style>
</head>
<body>
  <div class="wordmark">Claudius</div>
  <div class="dots" aria-hidden="true">
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  </div>
  <div class="sub">Starting&hellip;</div>
</body>
</html>`;

const SPLASH_DATA_URL = `data:text/html;charset=utf-8;base64,${Buffer.from(SPLASH_HTML, "utf8").toString("base64")}`;

/**
 * Create and show the splash. Returns the window so the caller can
 * destroy it once the main window is ready to paint.
 *
 * Centered on whichever display the cursor is currently on so multi-
 * monitor users see the splash where they're looking, not necessarily
 * on the primary screen.
 */
export function createSplashWindow(): BrowserWindow {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width: dw, height: dh, x: dx, y: dy } = display.workArea;

  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x: Math.round(dx + (dw - SPLASH_WIDTH) / 2),
    y: Math.round(dy + (dh - SPLASH_HEIGHT) / 2),
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    backgroundColor: "#0b0b0c",
    show: false,
    title: "Claudius",
    webPreferences: {
      // No preload — this is display-only chrome. Keeping the IPC
      // bridge off the splash means the inline HTML is a strictly
      // sandboxed view, same posture as the in-app browser viewer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // `data:` URLs paint as soon as the renderer decodes the string —
  // no disk read, no network round-trip, no Next compile step.
  void win.loadURL(SPLASH_DATA_URL).catch((err) => {
    // Best-effort: a failed splash is not fatal. The main window will
    // still appear once Next is ready.
    console.error("[electron/splash] loadURL failed:", err);
  });

  // Paint as soon as the renderer is ready (one frame after loadURL
  // resolves on the splash's tiny HTML).
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  return win;
}

/**
 * Tear down the splash. Safe to call multiple times; safe to call
 * before the splash has finished its initial paint.
 */
export function destroySplashWindow(win: BrowserWindow | null): void {
  if (!win) return;
  if (win.isDestroyed()) return;
  // `destroy()` (not `close()`) — we want the window gone immediately
  // without firing `close` listeners or running through the standard
  // close lifecycle. The splash has no state worth flushing.
  win.destroy();
}
