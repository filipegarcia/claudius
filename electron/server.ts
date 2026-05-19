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
  close: () => Promise<void>;
};

/**
 * Start Next.js inside the main process, listening on a random free
 * port on the loopback interface. The returned `url` is what the
 * BrowserWindow should `loadURL()`.
 *
 * @param appDir Absolute path to the directory containing the .next/
 *   build output. In packaged builds this is `process.resourcesPath`
 *   (or one level above, depending on how electron-builder lays out
 *   `extraResources`); in dev it should be the project root.
 */
export async function startEmbeddedNextServer(
  appDir: string,
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 — let the kernel pick a free ephemeral port. Binding to
    // 127.0.0.1 (NOT 0.0.0.0) keeps the server invisible to other
    // machines on the LAN — important because the renderer trusts this
    // server implicitly (same-origin) and the Claude Agent SDK has
    // permission to run shell commands.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
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
  // When packaged, electron-builder copies `.next/standalone/` to
  // `process.resourcesPath` (because we listed it in the `files` glob).
  // In dev, fall back to two levels above this file (electron/ →
  // project root).
  if (process.env.CLAUDIUS_PACKAGED === "1") {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, "..", "..");
}
