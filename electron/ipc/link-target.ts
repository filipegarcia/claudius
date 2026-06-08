/**
 * Main-process routing logic for outbound link clicks.
 *
 * The renderer pushes the user's preference (`"external"` | `"in-app"`)
 * over the `link-target:set` IPC channel; we cache it in a module-level
 * variable so `setWindowOpenHandler` in `electron/main.ts` can branch
 * synchronously on every click without an async round-trip to React.
 *
 * The `resolveLinkAction` function is pure and lives here (not in
 * `lib/shared/link-target.ts`) because the codebase keeps `electron/` and
 * `lib/` cleanly separated — `electron/tsconfig.json` has `rootDir: "."`
 * so cross-imports would break the main-process bundle. The TYPE is
 * duplicated from `lib/shared/link-target.ts`; keep them in lockstep.
 */
import { ipcMain } from "electron";

/** Mirror of `LinkTarget` in `lib/shared/link-target.ts`. */
export type LinkTarget = "external" | "in-app";

/** IPC channel name. Renderer (preload.ts) and main both reference this. */
export const TOPIC_SET = "link-target:set";

/** Default until the renderer pushes its first preference. */
const DEFAULT_TARGET: LinkTarget = "external";

let currentTarget: LinkTarget = DEFAULT_TARGET;

/**
 * Per-click decision returned by `resolveLinkAction`:
 *
 *   - `"internal-allow"` — let Chromium open the URL as a regular child
 *     window with the Claudius preload attached. ONLY for URLs that point
 *     at the embedded Next / dev / remote server's exact origin (or one of
 *     its loopback equivalents on the same port).
 *   - `"external"` — hand to `shell.openExternal`.
 *   - `"in-app"` — open in the sandboxed `electron/ipc/in-app-browser.ts`
 *     window.
 */
export type LinkAction = "internal-allow" | "external" | "in-app";

/** Loopback hostnames considered equivalent for the internal-origin check. */
const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  // `new URL("http://[::1]/").hostname` is `[::1]` per WHATWG; some older
  // runtimes return the bare `::1`. Accept both.
  "[::1]",
  "::1",
]);

/**
 * Decide what to do with a URL the renderer is trying to open. Pure — no
 * Electron, no shell, no DOM access.
 *
 * The internal carve-out wins regardless of `pref`: URLs that resolve to
 * the same origin as the embedded / dev / remote server stay in the
 * Claudius preload context (extracting them to a sandboxed window would
 * break the very bridge we use to talk to the app). The check is
 * deliberately narrow — only the app's actual `(scheme, host, port)`
 * triple (with loopback host equivalence for the dev/packaged Next
 * server) qualifies. A localhost link to *another* port (e.g. a user's
 * `http://localhost:81` admin app) is NOT internal — that's an external
 * destination that should follow the user's link-target preference.
 *
 * Unsupported / weird URL schemes (file://, mailto:, claudius://) fall
 * back to `"external"` — `shell.openExternal` is the OS-correct handler
 * for those.
 */
export function resolveLinkAction(
  url: string,
  pref: LinkTarget,
  appOrigin: string,
): LinkAction {
  if (typeof url !== "string" || url.length === 0) return "external";
  if (isInternalAppUrl(url, appOrigin)) return "internal-allow";
  if (pref === "in-app" && isHttpUrl(url)) return "in-app";
  return "external";
}

/**
 * True iff `url` points at the same origin as `appOrigin` — i.e. the
 * embedded Next server (packaged), the dev `next dev` server, or the
 * configured remote backend. Uses WHATWG URL parsing (not `startsWith`)
 * so `http://attacker.example/?host=127.0.0.1` can't squeak through.
 *
 * Loopback equivalence: when the app origin is on `127.0.0.1` /
 * `localhost` / `[::1]`, links targeting any of those hostnames on the
 * SAME port are also considered internal — they all reach the same
 * loopback server. The port match is mandatory; this is the bit the
 * original `startsWith("http://localhost")` check missed.
 */
export function isInternalAppUrl(url: string, appOrigin: string): boolean {
  let target: URL;
  let app: URL;
  try {
    target = new URL(url);
    app = new URL(appOrigin);
  } catch {
    return false;
  }
  if (target.protocol !== app.protocol) return false;
  // Exact origin match — the common case (same hostname, same port).
  if (target.origin === app.origin) return true;
  // Loopback equivalence only when BOTH the app origin and the URL are
  // loopback hostnames and they share the same port. A remote-backend
  // origin doesn't get this carve-out (loopback links there are NOT
  // the same server).
  if (target.port !== app.port) return false;
  return (
    LOOPBACK_HOSTNAMES.has(target.hostname) &&
    LOOPBACK_HOSTNAMES.has(app.hostname)
  );
}

/**
 * Legacy helper retained for tests and as a quick "does this URL look
 * like a loopback HTTP address" predicate. NOT used by `resolveLinkAction`
 * any more — see `isInternalAppUrl` for the routing-grade check.
 */
export function isLocalhostHttpUrl(url: string): boolean {
  return (
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost") ||
    url.startsWith("http://[::1]")
  );
}

/**
 * True only for http(s):// URLs. The in-app viewer is a Chromium
 * BrowserWindow — it can only render web schemes. Anything else
 * (file://, mailto:, claudius://, javascript:) goes to `shell.openExternal`
 * which dispatches via the OS handler.
 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Current cached preference. Reads are cheap; main calls this per click. */
export function getLinkTarget(): LinkTarget {
  return currentTarget;
}

/**
 * Register the `link-target:set` IPC listener. Call once from `main.ts`
 * after `app.whenReady()`. The renderer pushes `"external"` / `"in-app"`
 * after reading from localStorage — see `lib/client/useElectronLinkTargetSync.ts`.
 */
export function registerLinkTargetHandlers(): void {
  ipcMain.on(TOPIC_SET, (_event, raw: unknown) => {
    if (raw === "external" || raw === "in-app") {
      const prev = currentTarget;
      currentTarget = raw;
      if (prev !== raw) {
        // Low-frequency event (only fires when the user changes the
        // /settings → Link target picker, or on first renderer mount).
        // Logged unconditionally so anyone debugging a stuck preference
        // can confirm the IPC actually landed.
        console.log(`[electron/link-target] preference updated: ${prev} → ${raw}`);
      }
    } else {
      console.warn(`[electron/link-target] ignoring invalid payload:`, raw);
    }
  });
}

/**
 * Test-only reset. Vitest uses this between cases — production code
 * never calls it because preferences only change in response to user
 * action via IPC.
 */
export function __resetLinkTargetForTest(): void {
  currentTarget = DEFAULT_TARGET;
}
