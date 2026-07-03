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
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { registerBadgeHandlers } from "./ipc/badge";
import { createBus } from "./ipc/bus";
import { registerContextMenu } from "./ipc/context-menu";
import {
  notifyRendererReady,
  registerDeepLinkHandlers,
  registerProtocol,
} from "./ipc/deep-links";
import { registerDialogHandlers } from "./ipc/dialogs";
import { openInAppBrowser } from "./ipc/in-app-browser";
import {
  getLinkTarget,
  registerLinkTargetHandlers,
  resolveLinkAction,
} from "./ipc/link-target";
import { registerNotificationHandlers } from "./ipc/notifications";
import { registerPermissionPrimingHandlers } from "./ipc/permission-priming";
import { registerUpdaterHandlers } from "./ipc/updater";
import { installAppMenu, type MenuAccelerators } from "./menu";
import { startHttp2Proxy, type EmbeddedProxy } from "./proxy";
import {
  defaultAppDir,
  startEmbeddedNextServer,
  type EmbeddedNextServer,
} from "./server";
import { createSplashWindow, destroySplashWindow } from "./splash";

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

// Bridge `app.isPackaged` into the env flag that server.ts reads. The
// `CLAUDIUS_PACKAGED=1` set by the build scripts only lives for the
// duration of the `next build` command — it is NOT baked into the
// shipped app. At runtime the only reliable signal that we're inside a
// packaged `.app`/asar is `app.isPackaged`, so propagate it here, before
// `defaultAppDir()` runs, so the embedded server resolves the standalone
// build inside the asar instead of the (non-existent) dev project root.
if (app.isPackaged) process.env.CLAUDIUS_PACKAGED = "1";

// macOS: strip `com.apple.quarantine` from the bundle's Resources tree on
// first launch.
//
// Why: a zip-distributed unsigned/adhoc build inherits quarantine on every
// inner file when the browser flags the download. Gatekeeper lets the user
// "approve" the .app itself (right-click → Open), but the deeply-nested
// `claude` SDK binary at `Resources/standalone/node_modules/@anthropic-ai/
// claude-agent-sdk-darwin-<arch>/claude` is never directly approved. When
// the embedded Next server tries to spawn it, the hardened-runtime + quarantine
// combination on the nested binary causes the spawn to fail with EPERM (the
// SDK surfaces it as "Claude Code native binary at … exists but failed to
// launch"). DMG-installed apps don't hit this because copying from a mounted
// DMG to /Applications doesn't propagate quarantine to the inner files.
//
// Safe: shells out to /usr/bin/xattr, fire-and-forget. Failures (no xattr,
// no write access, the attribute isn't present) are all ignored — this is a
// best-effort safety net, not a hard requirement. Runs ONCE at startup; the
// xattr stays cleared until the user re-downloads.
//
// Re-running on every launch is idempotent and cheap (~50ms cold, <5ms when
// nothing to strip), so we don't bother gating it on a "did we already run"
// marker.
if (process.platform === "darwin" && app.isPackaged) {
  try {
    const child = spawn(
      "/usr/bin/xattr",
      ["-dr", "com.apple.quarantine", process.resourcesPath],
      { stdio: "ignore", detached: false },
    );
    child.on("error", () => {
      // xattr missing / not executable / spawn race — swallow.
    });
    // No `.unref()`: we want the process to be reaped, not orphaned.
  } catch {
    // Defensive: spawn() shouldn't throw synchronously for a missing binary
    // (it emits 'error' instead), but if it does, ignore.
  }
}

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

// Linux boot marker. The Chromium setuid-sandbox host inits BEFORE any of our
// JS runs, so the AppImage sandbox crash can't be fixed in-app — it's handled
// at the launch layer by build/after-pack.js's --no-sandbox wrapper. This line
// (the first user-JS statement on Linux) is the positive confirmation in the
// linux-smoke pre-check that our process actually reached JS: present + no
// setuid FATAL = the wrapper put --no-sandbox on the real argv. Linux-only so
// mac/win startup stays quiet.
if (process.platform === "linux") {
  process.stderr.write(
    `[electron/main] boot pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} APPIMAGE=${process.env.APPIMAGE ?? "<unset>"}\n`,
  );
}

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
let splashWindow: BrowserWindow | null = null;
let nextServer: EmbeddedNextServer | null = null;
// The HTTP/2 TLS proxy that fronts the standalone Next server in packaged
// builds (electron/proxy.ts). Null in dev / remote-backend / proxy-fallback
// modes, where the renderer talks to an http origin directly.
let proxy: EmbeddedProxy | null = null;
// The origin the renderer is loaded from — `https://127.0.0.1:<proxyPort>` when
// the proxy is up, else the plain-http Next/dev/remote origin. Module-level so
// the `certificate-error` handler and the outbound-link carve-out both read the
// same value. Set by resolveStartUrl before any loadURL.
let appOrigin = "http://invalid.invalid";
// The exact fingerprint (`sha256/<base64>`) of our self-signed loopback cert.
// The `certificate-error` handler trusts ONLY this cert on ONLY `appOrigin`.
// Null when the proxy isn't in use.
let expectedFingerprint: string | null = null;

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

// Trust our self-signed loopback cert — but ONLY that exact cert, and ONLY on
// our own origin. The in-app browser (electron/ipc/in-app-browser.ts) can
// navigate to arbitrary https, so a blanket `callback(true)` would defeat TLS
// for real sites. Default is reject; we bypass solely for a fingerprint match
// on `appOrigin`. `expectedFingerprint` is null unless the h2 proxy is up.
app.on("certificate-error", (event, _webContents, url, _error, certificate, callback) => {
  try {
    if (
      expectedFingerprint != null &&
      new URL(url).origin === appOrigin &&
      certificate.fingerprint === expectedFingerprint
    ) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {
    // Malformed URL / cert — fall through to the safe default.
  }
  callback(false);
});

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

/**
 * Path to the persisted embedded-server port. Same `userData` we set above,
 * so the file follows the branded "Claudius" dir across platforms. Stable
 * across `app:` builds, e2e tests with `--user-data-dir` get their own
 * isolated path.
 */
function portFilePath(): string {
  return path.join(app.getPath("userData"), "embedded-port");
}

/**
 * Read the embedded-server port persisted by the previous launch. Returns
 * undefined for any reason — file missing, malformed contents, out of
 * range. The caller falls back to a kernel-chosen random port and writes
 * the new one back.
 */
async function readPersistedPort(): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(portFilePath(), "utf8");
    const n = parseInt(raw.trim(), 10);
    // Ephemeral / privileged ports are unsafe to reuse — clamp to the
    // user range (1024–65535). Anything outside means the file is stale
    // or corrupt; fall back to random.
    if (Number.isFinite(n) && n >= 1024 && n <= 65535) return n;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Persist the resolved port so the next launch reads it back. Best-effort. */
async function writePersistedPort(port: number): Promise<void> {
  try {
    await fs.writeFile(portFilePath(), String(port), "utf8");
  } catch (err) {
    console.warn("[electron/main] could not persist embedded port:", err);
  }
}

/**
 * Load the self-signed loopback cert that fronts the packaged app over HTTP/2
 * (see electron/proxy.ts + scripts/electron-gen-cert.mjs). Packaged: shipped to
 * `<Resources>/cert/` via electron-builder.yml. Dev/smoke: `<project>/build/cert/`
 * (this file compiles to `dist-electron/main.js`, so `build/` is one level up).
 *
 * Returns null when the cert is missing — the caller then degrades to serving
 * plain http (the pre-proxy behavior), so a missing/broken cert can't brick the
 * app. The fingerprint is computed here in Electron's own format
 * (`sha256/<base64-of-DER>`) so the `certificate-error` handler matches exactly.
 */
async function loadProxyCert(): Promise<{
  key: Buffer;
  cert: Buffer;
  fingerprint: string;
} | null> {
  const dir =
    process.env.CLAUDIUS_PACKAGED === "1"
      ? path.join(process.resourcesPath, "cert")
      : path.resolve(__dirname, "..", "build", "cert");
  try {
    const [key, cert] = await Promise.all([
      fs.readFile(path.join(dir, "key.pem")),
      fs.readFile(path.join(dir, "cert.pem")),
    ]);
    const der = new X509Certificate(cert).raw;
    const fingerprint = "sha256/" + createHash("sha256").update(der).digest("base64");
    return { key, cert, fingerprint };
  } catch (err) {
    console.warn(
      "[electron/main] proxy cert unavailable, falling back to http:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Remote-backend override. When set, the renderer loads from this URL and
 * we SKIP the embedded-Next bootstrap entirely — the Electron process
 * becomes a thin native shell (notifications, dialogs, OS menu, IPC bridge)
 * over a backend hosted elsewhere (container, devbox, remote VM).
 *
 * Accepts either:
 *   - env var `CLAUDIUS_REMOTE_URL=http://host:port`, OR
 *   - CLI flag `--remote-url=http://host:port`
 *
 * Honored in BOTH dev and packaged builds (unlike `ELECTRON_START_URL`,
 * which is dev-only). See `docs/electron-conversion/REMOTE-BACKEND.md`
 * for the container / port-forwarding setup.
 */
function resolveRemoteUrl(): string | undefined {
  const flagPrefix = "--remote-url=";
  const flag = process.argv.find((a) => a.startsWith(flagPrefix));
  if (flag) return flag.slice(flagPrefix.length);
  const env = process.env.CLAUDIUS_REMOTE_URL;
  if (env && env.length > 0) return env;
  return undefined;
}

async function resolveStartUrl(): Promise<string> {
  // Remote backend (container / devbox / VM) — works in packaged builds too.
  // Skips the embedded-Next bootstrap entirely.
  const remoteUrl = resolveRemoteUrl();
  if (remoteUrl) {
    console.log(`[electron/main] using remote backend at ${remoteUrl}`);
    return remoteUrl;
  }

  // Dev: a `next dev` is already running on :3000. The concurrently
  // pipeline in `bun run electron:dev` set ELECTRON_START_URL before
  // launching us.
  if (DEV_START_URL && !IS_PACKAGED) {
    return DEV_START_URL;
  }

  // Packaged: standalone Next on an EPHEMERAL internal loopback port (the
  // browser never sees it), fronted by an HTTP/2 TLS proxy on a STABLE public
  // port. HTTP/2 multiplexes every request + SSE stream over one connection,
  // eliminating Chromium's 6-connections-per-origin limit that stalled
  // navigations for 10-17s once the pool saturated. See electron/proxy.ts.
  nextServer = await startEmbeddedNextServer(defaultAppDir());
  console.log(`[electron/main] embedded server listening at ${nextServer.url} (internal)`);

  // Why the PUBLIC (proxy) port must be stable: Chromium keys localStorage /
  // IndexedDB by origin (scheme + host + port). A random port every launch =
  // a brand-new storage bucket every launch, resetting every localStorage
  // preference (theme, shortcuts, dismissed banners). Persist + reuse it.
  const preferredPublicPort = await readPersistedPort();
  const certBundle = await loadProxyCert();

  if (certBundle) {
    try {
      proxy = await startHttp2Proxy({
        internalOrigin: nextServer.url,
        publicPort: preferredPublicPort,
        key: certBundle.key,
        cert: certBundle.cert,
      });
      appOrigin = new URL(proxy.url).origin;
      expectedFingerprint = certBundle.fingerprint;
      if (proxy.port !== preferredPublicPort) {
        await writePersistedPort(proxy.port);
      }
      console.log(`[electron/main] h2 proxy listening at ${proxy.url} (public)`);
      return proxy.url;
    } catch (err) {
      // Proxy init failed (port unbindable, TLS error). Degrade to plain http
      // rather than brick the app — the 6-connection limit returns, but the
      // app works. Tear down any half-started proxy first.
      console.error("[electron/main] h2 proxy failed to start, using http fallback:", err);
      if (proxy) {
        try {
          await proxy.close();
        } catch {
          // ignore
        }
        proxy = null;
      }
    }
  }

  // Fallback path (no cert, or proxy failed): serve the internal http URL
  // directly — today's known-good behavior.
  appOrigin = new URL(nextServer.url).origin;
  expectedFingerprint = null;
  console.log(`[electron/main] serving http directly at ${nextServer.url} (proxy disabled)`);
  return nextServer.url;
}

/**
 * Pre-warm the embedded server's root route. The first request to the
 * standalone Next server pays one-time costs (React's renderToString
 * init, per-request module imports, the first DB connection open). If
 * the renderer's `loadURL(/)` is the request that pays them, the user
 * sees the splash for an extra ~500ms-1s while the renderer waits on
 * SSR. Issuing a synthetic GET BEFORE the renderer hits the server
 * shifts that work earlier on the wall clock — the renderer's request
 * then arrives on a warm server and returns immediately.
 *
 * Bounded by a short timeout so a misbehaving SSR can't hold up window
 * creation. If the prewarm times out or errors, the main window's own
 * load will still trigger SSR normally — net-net we lose nothing.
 */
async function prewarmRootRoute(serverUrl: string): Promise<void> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(serverUrl + "/", { signal: controller.signal });
    await res.text();
    console.log(`[electron/main] prewarmed / in ${Date.now() - start}ms (status ${res.status})`);
  } catch (err) {
    console.warn(
      `[electron/main] prewarm / failed after ${Date.now() - start}ms (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function createWindow(startUrl: string): BrowserWindow {
  // The module-level `appOrigin` was set by resolveStartUrl (which runs before
  // any createWindow call) to the origin the renderer loads — the https proxy
  // origin when the h2 proxy is up, else the plain-http Next/dev/remote origin.
  // The `internal-allow` carve-out in `resolveLinkAction` (window-open handler
  // below) matches against it so loopback clicks stay in-app; without it a
  // click on `http://localhost:81` (a user's OWN admin app) would open a
  // default child window instead of following the link-target preference.
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
      //
      // Spell-check stays explicit so the right-click "did you mean…"
      // suggestions in `electron/ipc/context-menu.ts` always have
      // `params.misspelledWord` / `params.dictionarySuggestions` to read.
      // Electron defaults `spellcheck` to true today; pinning it here
      // protects against a future default flip and documents intent.
      // Languages default to the system locale — see the
      // `setSpellCheckerLanguages` belt-and-braces call further down.
      spellcheck: true,
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

  // Outbound-link routing. Three branches:
  //   - localhost/127.0.0.1 → child window with Claudius preload attached
  //     (trusted app content; this is how the embedded Next server gets to
  //     keep using the IPC bridge). The preference is ignored here — the
  //     loopback URL is part of the app, not an external destination.
  //   - external + pref="in-app" → sandboxed BrowserWindow in
  //     `electron/ipc/in-app-browser.ts`. NO preload, dedicated session
  //     partition; verified by `window.claudius` being undefined inside.
  //   - external + pref="external" (default) → `shell.openExternal`.
  // See `electron/ipc/link-target.ts` for the pure decision function and
  // its unit tests.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const pref = getLinkTarget();
    const action = resolveLinkAction(url, pref, appOrigin);
    // One log per outbound click — low frequency, high value for diagnosing
    // "I switched to Default browser but links still open in-app" reports.
    // Shows the cached preference, the URL, and the action we took, so any
    // mismatch between /settings UI state and main-process state is obvious.
    console.log(
      `[electron/link-target] click pref=${pref} action=${action} appOrigin=${appOrigin} url=${url}`,
    );
    switch (action) {
      case "internal-allow":
        return { action: "allow" };
      case "in-app":
        openInAppBrowser(url);
        return { action: "deny" };
      case "external":
        shell.openExternal(url).catch(() => {
          // Best-effort; nothing actionable if it fails.
        });
        return { action: "deny" };
    }
  });

  // Right-click context menu. Without this Chromium suppresses its built-in
  // context menu and Copy/Paste-via-mouse is dead in the packaged build —
  // Cmd+C still works through the Edit menu, but right-click → Copy is the
  // natural reflex. See `electron/ipc/context-menu.ts` for the template.
  registerContextMenu(win);

  // Belt-and-braces for the spell-checker. macOS uses NSSpellChecker
  // automatically and ignores this list; Windows/Linux load Hunspell
  // dictionaries and need a language list. Chromium auto-detects the
  // system locale by default — we only force-seed when no languages have
  // been picked up (defensive: avoids a future Electron default change
  // breaking the "did you mean…" entries in the right-click menu).
  // Grant microphone access when the renderer requests it via
  // `getUserMedia({ audio: true })`. Without this handler Electron
  // returns the WHATWG spec default ("denied"), and the voice-
  // dictation button silently fails — the renderer sees a
  // NotAllowedError it can't recover from.
  //
  // The CHECK handler answers Chromium's "do you already have
  // permission?" probe (no UI is shown), the REQUEST handler runs
  // when the renderer actually calls `getUserMedia` and is allowed
  // to show UI. We grant unconditionally because the only renderer
  // that can reach here is Claudius's own first-party UI (Electron's
  // session-isolation means external pages get a different session
  // — see the `in-app-browser.ts` flow that creates a sandbox session
  // with no preload).
  //
  // macOS still gates the OS-level mic access on
  // `NSMicrophoneUsageDescription` in the bundle's Info.plist —
  // that's set via electron-builder.yml's `mac.extendInfo`.
  try {
    const ses = win.webContents.session;
    // Electron's union types for the check vs. request handlers diverge
    // (the request side has no `"microphone"` variant — Chromium routes
    // mic access through the `"media"` umbrella), so we widen both
    // signatures and let the matchers express the real Chromium event
    // names. Keeping it lenient avoids brittle exhaustive switches
    // breaking on a future Electron release that adds a new variant.
    // `clipboard-sanitized-write` (and `clipboard-read`) gate the renderer's
    // async Clipboard API (`navigator.clipboard.writeText`/`readText`). With a
    // custom check handler installed, Electron consults it for these too — so
    // omitting them makes every in-app "Copy" button silently reject
    // (NotAllowedError), even though the app loads over a secure 127.0.0.1
    // origin. The main-process context-menu Copy is unaffected because it
    // bypasses the renderer permission model entirely, which is why only the
    // in-renderer buttons broke. Allow them here so renderer-side copy works.
    const isAllowed = (p: string) =>
      p === "media" ||
      p === "microphone" ||
      p === "notifications" ||
      p === "clipboard-read" ||
      p === "clipboard-sanitized-write";
    ses.setPermissionCheckHandler((_wc, permission) =>
      isAllowed(permission as string),
    );
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(isAllowed(permission as string));
    });
  } catch (err) {
    console.error("[electron/main] permission handler install failed:", err);
  }

  try {
    const ses = win.webContents.session;
    if (ses.availableSpellCheckerLanguages.length > 0) {
      const current = ses.getSpellCheckerLanguages();
      if (current.length === 0) {
        // Default to en-US as a reasonable floor — the user's real locale
        // will be picked up by Chromium on Windows/Linux when present;
        // this branch only fires if auto-detect handed back nothing.
        ses.setSpellCheckerLanguages(["en-US"]);
      }
    }
  } catch (err) {
    // Best-effort. The context menu still shows "No spelling suggestions"
    // when params.dictionarySuggestions is empty, so a configuration
    // failure here is recoverable.
    console.error("[electron/main] spell-checker init failed:", err);
  }

  // NOTE — we deliberately do NOT intercept menu-owned chords via
  // `before-input-event` here. Electron documents that calling
  // `event.preventDefault()` in that handler suppresses "the page
  // keydown/keyup events AND the menu shortcuts" — i.e. it KILLS the very
  // native-menu accelerator (Cmd+T / Cmd+W / …) we rely on to dispatch the
  // action. An earlier revision swallowed every owned chord here, which is
  // exactly why all menu shortcuts were dead in the packaged build.
  //
  // The native menu accelerator (electron/menu.ts) is now the single owner of
  // those chords: when it fires it consumes the key, so Chromium's built-in
  // doesn't fire alongside it — no swallow needed. The renderer's web-parity
  // keydown listeners stay inert for these chords in Electron via
  // `useKeydownBinding` (lib/client/useKeydownBinding.ts), so the menu is the
  // sole handler and there's no double-fire.

  void win.loadURL(startUrl);
  return win;
}

app.whenReady().then(async () => {
  try {
    // Paint a tiny splash window BEFORE the slow bits (embedded Next
    // boot, first SSR). Without this the dock bounces and nothing
    // visible happens for several seconds on cold start. See
    // `electron/splash.ts` for why a renderer-side overlay can't do
    // this — the renderer booting *is* the wait we're masking.
    //
    // Skipped when a remote backend is configured: in that mode the
    // renderer points at an external URL with no embedded-Next boot,
    // so cold start is already a normal HTTP round-trip and the
    // splash would just flash on screen for a frame.
    if (!resolveRemoteUrl()) {
      splashWindow = createSplashWindow();
    }
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
    // First-run macOS TCC file-permission priming — lets the renderer
    // front-load the Files & Folders consent prompts from an explanatory
    // modal instead of having them fire at random mid-session.
    registerPermissionPrimingHandlers();
    registerLinkTargetHandlers();
    registerDeepLinkHandlers({
      resolveWindow: () => mainWindow,
    });
    // Phase 7 of docs/electron-conversion/PLAN.md — the packaged
    // build's auto-updater is owned by Electron; tell the embedded
    // Next process to skip its own git-pull updater so we don't have
    // two paths trying to rewrite the install at once.
    if (IS_PACKAGED) process.env.CLAUDIUS_UPDATER_DISABLED = "1";
    const startUrl = await resolveStartUrl();

    // Pre-warm the embedded server's `/` route BEFORE the renderer asks
    // for it. The splash is already up, so paying the SSR cost here
    // (instead of inside `mainWindow.loadURL`) doesn't add user-perceived
    // wait time — it just shifts the work earlier on the wall clock so
    // the splash → main-window swap is one clean transition rather than
    // "blank main window paints, sits for a beat, then content fills in".
    // No-op for the remote-backend mode (nextServer is null). Warm the INTERNAL
    // Next origin directly — no reason to route a synthetic GET through the TLS
    // proxy, and it works identically whether or not the proxy came up.
    if (nextServer != null) {
      await prewarmRootRoute(nextServer.url);
    }

    mainWindow = createWindow(startUrl);

    // Tear down the splash the moment the main window is ready to
    // paint — `ready-to-show` fires once on first paint and is the
    // signal we used to gate the main window's own `show()`, so by
    // the time it fires the user is about to see the real UI.
    mainWindow.once("ready-to-show", () => {
      destroySplashWindow(splashWindow);
      splashWindow = null;
    });

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
    // Don't leave the splash hanging on a startup failure — without
    // this it stays on screen forever (closable: false on the main
    // window, but the splash has no traffic lights either).
    destroySplashWindow(splashWindow);
    splashWindow = null;
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
  // Best-effort splash teardown in case quit fires before the main
  // window's `ready-to-show` (e.g. user Cmd+Q during startup).
  destroySplashWindow(splashWindow);
  splashWindow = null;
  // Tear down the proxy BEFORE the Next server: the proxy holds upstream
  // sockets to it, and closing the proxy destroys live SSE sessions.
  if (proxy) {
    try {
      await proxy.close();
    } catch {
      // Ignore — we're tearing down anyway.
    }
    proxy = null;
  }
  if (nextServer) {
    try {
      await nextServer.close();
    } catch {
      // Ignore — we're tearing down anyway.
    }
    nextServer = null;
  }
});
