/**
 * Custom-protocol deep-link handling — Phase 8 of
 * docs/electron-conversion/PLAN.md.
 *
 * Supports URLs of the shape:
 *
 *   claudius://workspace/<workspaceId>?session=<sessionId>
 *   claudius://session/<sessionId>
 *
 * Cold-start payloads (the URL that launched the app) are queued
 * until the first BrowserWindow's `did-finish-load` fires; warm
 * focus events flush immediately. The renderer subscribes via
 * `bridge.deepLinks.onOpen(cb)` and the chat page handles navigation
 * (Phase 9 wiring).
 */
import { app, BrowserWindow } from "electron";

const TOPIC_OPEN = "deeplink:open";
const PROTOCOL = "claudius";

type DeepLinkContext = {
  /** Get the active window once one exists. */
  resolveWindow: () => BrowserWindow | null;
};

let pending: string[] = [];
let armed = false;
let ctx: DeepLinkContext | null = null;

/**
 * Register the protocol with the OS so `claudius://...` URLs route
 * here. Idempotent — safe to call every boot.
 */
export function registerProtocol(): void {
  if (process.defaultApp) {
    // Dev: electron launched via "electron .", so the protocol needs
    // the path to the script too.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        process.argv[1] ?? "",
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Wire main-process events to the URL queue + dispatch. */
export function registerDeepLinkHandlers(c: DeepLinkContext): void {
  ctx = c;

  // macOS — single instance gets `open-url` events even when already
  // running. Triggered by `open claudius://...` in Terminal or a
  // browser link.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    enqueue(url);
  });

  // Windows / Linux — protocol arguments come in via the launch
  // argv; second-instance fires when a second copy is opened with
  // a deep link.
  app.on("second-instance", (_event, argv) => {
    for (const arg of argv) {
      if (arg.startsWith(`${PROTOCOL}://`)) enqueue(arg);
    }
  });

  // Inspect the launch argv for a cold-start deep link.
  for (const arg of process.argv) {
    if (arg.startsWith(`${PROTOCOL}://`)) enqueue(arg);
  }

  armed = true;
  // Flush any URLs queued before the renderer was ready.
  flush();
}

/**
 * Called by `electron/main.ts` once the first BrowserWindow has
 * finished its initial load — that's when the preload's
 * `deepLinks.onOpen(cb)` listener is guaranteed to be subscribed.
 */
export function notifyRendererReady(): void {
  flush();
}

function enqueue(url: string): void {
  if (!url || typeof url !== "string") return;
  pending.push(url);
  if (armed) flush();
}

function flush(): void {
  if (!ctx) return;
  const win = ctx.resolveWindow();
  if (!win) return;
  const queue = pending;
  pending = [];
  for (const url of queue) {
    try {
      win.webContents.send(TOPIC_OPEN, url);
    } catch (err) {
      console.error("[electron/deeplinks] dispatch failed:", err);
      // Re-queue so a later flush has a chance.
      pending.push(url);
      return;
    }
  }
}
