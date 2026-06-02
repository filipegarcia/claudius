/**
 * Embed a Next.js server inside the Electron main process.
 *
 * Phase 1 of docs/electron-conversion/PLAN.md.
 *
 * We import the Next factory dynamically so the main-process bundle
 * compiled by `tsc -p electron/tsconfig.json` doesn't need to resolve
 * Next at typecheck time — electron-builder later unpacks
 * `node_modules/next/**` into the .asar's resources so the runtime
 * `require("next")` resolves.
 *
 * In dev (`bun run electron:dev`), the renderer is pointed at the
 * already-running `next dev` on :3000 via `ELECTRON_START_URL` and this
 * module is NOT used. Only the packaged build needs the embedded
 * server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export type EmbeddedNextServer = {
  url: string;
  /** The actual port the server bound to — may differ from `preferredPort`. */
  port: number;
  close: () => Promise<void>;
};

/**
 * Start Next.js inside the main process, listening on `preferredPort` on
 * the loopback interface — falling back to a random ephemeral port if the
 * preferred port is taken or omitted. The returned `url` is what the
 * BrowserWindow should `loadURL()`.
 *
 * Why preferredPort matters — Chromium keys localStorage / IndexedDB by
 * origin (scheme + host + **port**). A fresh random port on every launch
 * means a brand-new storage bucket on every launch, so every user
 * preference stored client-side (theme, shortcuts, link-target, the
 * "Opus 4.8 is here" dismissal banner, …) gets reset. Persisting the
 * port across launches (see `resolveStartUrl` in `electron/main.ts`)
 * stabilizes the origin and lets localStorage actually persist.
 *
 * @param appDir Absolute path to the directory containing the .next/
 *   build output. In packaged builds this is `process.resourcesPath`
 *   (or one level above, depending on how electron-builder lays out
 *   `extraResources`); in dev it should be the project root.
 * @param preferredPort If set, attempt to bind here first. Caller is
 *   responsible for persisting the resolved port (it may have fallen
 *   back to random) so the next launch can request it.
 */
export async function startEmbeddedNextServer(
  appDir: string,
  preferredPort?: number,
): Promise<EmbeddedNextServer> {
  // Dynamic require — see file header for rationale.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const next = require("next") as typeof import("next").default;

  const app = next({
    dev: false,
    dir: appDir,
    // Quiet by default; main-process logs go to the OS-level log file
    // anyway. The renderer can ask for verbose output via an env flag.
    quiet: process.env.CLAUDIUS_ELECTRON_VERBOSE !== "1",
  });

  await app.prepare();
  const handler = app.getRequestHandler();

  const server: Server = createServer((req, res) => {
    // Next's request handler returns a promise; surface unhandled
    // rejections through the response instead of crashing the process.
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error("[electron/server] handler error:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  // Bind to 127.0.0.1 (NOT 0.0.0.0) to keep the server invisible to other
  // machines on the LAN — important because the renderer trusts this server
  // implicitly (same-origin) and the Claude Agent SDK has permission to run
  // shell commands.
  //
  // Port resolution: try `preferredPort` first (so localStorage stays
  // stable across launches); fall back to a kernel-chosen ephemeral port
  // on EADDRINUSE / any bind error. The fallback can't be transparent —
  // the caller must persist the resolved port so future launches request
  // *this* port, not the one that just failed.
  if (preferredPort != null && Number.isFinite(preferredPort)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          server.removeListener("error", onError);
          reject(err);
        };
        server.once("error", onError);
        server.listen(preferredPort, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    } catch (err) {
      // Most likely EADDRINUSE — another instance of the app, an unrelated
      // service, or a leftover socket. Log so this is debuggable when a
      // user reports "localStorage reset itself for no reason", then
      // re-bind to a random port.
      console.warn(
        `[electron/server] preferred port ${preferredPort} unavailable, falling back to random:`,
        err,
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Resolve the directory Next should consider as the project root when
 * loading the standalone build. electron-builder's `output: "standalone"`
 * mode lays the files out under `.next/standalone/`, with the entry
 * server at `.next/standalone/server.js`. We point Next at the parent
 * directory so it can find both `.next/` and `public/`.
 */
export function defaultAppDir(): string {
  // Packaged: electron-builder ships the Next standalone tree verbatim as an
  // extraResource at `<app>/Contents/Resources/standalone` (see
  // electron-builder.yml). That dir holds a valid `.next/BUILD_ID` plus the
  // bundled node_modules + native `.node` files Next's `app.prepare()` needs.
  // It lives OUTSIDE the asar on the real filesystem because electron-builder
  // strips nested node_modules from the asar and `.node` can't be loaded from
  // inside an asar. `CLAUDIUS_PACKAGED` is set from `app.isPackaged` in
  // electron/main.ts at startup, NOT baked in at build time.
  if (process.env.CLAUDIUS_PACKAGED === "1") {
    return path.join(process.resourcesPath, "standalone");
  }
  // Dev / smoke: this file compiles to `dist-electron/server.js` (one level
  // beneath the project root), so a single `..` from `__dirname` gets us
  // back to the directory containing `.next/`.
  return path.resolve(__dirname, "..");
}
