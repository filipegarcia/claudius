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
 *     window with the Claudius preload attached. ONLY for `127.0.0.1` /
 *     `localhost` / `[::1]` URLs that point at the embedded Next server.
 *   - `"external"` — hand to `shell.openExternal`.
 *   - `"in-app"` — open in the sandboxed `electron/ipc/in-app-browser.ts`
 *     window.
 */
export type LinkAction = "internal-allow" | "external" | "in-app";

/**
 * Decide what to do with a URL the renderer is trying to open. Pure — no
 * Electron, no shell, no DOM access. The localhost carve-out wins
 * regardless of `pref` so the dev-server / embedded-Next loopback URLs
 * always stay in the Claudius preload context (extracting them to a
 * sandboxed window would break the very bridge we use to talk to the
 * app).
 *
 * Unsupported / weird URL schemes (file://, mailto:, claudius://) fall
 * back to `"external"` — `shell.openExternal` is the OS-correct handler
 * for those.
 */
export function resolveLinkAction(url: string, pref: LinkTarget): LinkAction {
  if (typeof url !== "string" || url.length === 0) return "external";
  if (isLocalhostHttpUrl(url)) return "internal-allow";
  if (pref === "in-app" && isHttpUrl(url)) return "in-app";
  return "external";
}

/**
 * True for `http://localhost…`, `http://127.0.0.1…`, and `http://[::1]…`
 * — the ONLY URLs we trust enough to load with the Claudius preload
 * attached. Anchored at the start of the string so a malicious
 * `http://attacker.example/?host=127.0.0.1` can't squeak through.
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
      currentTarget = raw;
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
