/**
 * Universal runtime-environment detection.
 *
 * `isElectron()` is the single canonical flag for branching
 * Electron-specific behavior anywhere in the codebase — client OR server,
 * React OR plain module. It reads whichever signal is available in the
 * current realm:
 *
 *  - **Renderer / browser:** `electron/preload.ts` mounts the
 *    `window.claudius` bridge with `isElectron: true`. A plain browser tab
 *    has no bridge, so this returns `false` — that's the web build.
 *  - **Server / Node:** `electron/main.ts` sets `CLAUDIUS_ELECTRON=1` in
 *    the environment before booting the embedded Next server, so route
 *    handlers and `lib/server/` code can branch too. Standalone
 *    `next dev` / `next start` (the web deployment) never sets it →
 *    `false`.
 *
 * Caveats:
 *  - **React components should prefer `useIsElectron()`**
 *    (`lib/client/useElectron.ts`) — it's SSR-safe and re-renders when the
 *    bridge resolves, so it won't cause a hydration mismatch. `isElectron()`
 *    is for everything that isn't a React render path (event handlers,
 *    utilities, server code).
 *  - Server-side detection is only `true` in the **packaged** build (the
 *    embedded in-process server). In `electron:dev` the renderer points at
 *    a standalone `next dev`, which doesn't inherit `CLAUDIUS_ELECTRON` —
 *    the renderer still reports Electron via `window.claudius`, but the dev
 *    server reports the web answer.
 */
export function isElectron(): boolean {
  // Renderer realm — the preload bridge is the source of truth.
  if (typeof window !== "undefined") {
    return window.claudius?.isElectron === true;
  }
  // Node realm — the env flag set by the Electron main process.
  return typeof process !== "undefined" && process.env.CLAUDIUS_ELECTRON === "1";
}

/** Inverse of {@link isElectron} — the standalone web build (browser tab or web server). */
export function isWeb(): boolean {
  return !isElectron();
}
