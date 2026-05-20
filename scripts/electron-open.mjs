#!/usr/bin/env node
/**
 * `electron:open` — smart launcher for the Claudius Electron shell.
 *
 * Decision tree on launch:
 *   1. Probe `http://127.0.0.1:<PORT>/` (PORT = $PORT or 3000).
 *      → If reachable: just compile `dist-electron/` and attach
 *        Electron to it. Don't spawn a second Next. Don't rebuild
 *        native modules (whatever ABI the running Next loaded is
 *        already in memory and works).
 *   2. Else: ensure native modules are built for plain-Node's ABI
 *      (because the spawned `next dev` runs in a plain Node child),
 *      compile `dist-electron/`, then run `next dev` + Electron via
 *      `concurrently` like `electron:dev` does.
 *
 * Why this exists
 * ---------------
 * `electron:dev` always rebuilds + spawns its own `next dev`. That
 * collides with an existing `bun run dev` on the same port and forces
 * a ~30 s native rebuild even when you just want to relaunch the
 * window. `electron:open` makes the common case (Next already running)
 * the fast path.
 *
 * Env knobs
 * ---------
 *   PORT             dev-server port to probe / spawn (default 3000)
 *   PROBE_TIMEOUT_MS HTTP probe timeout (default 1500ms)
 *
 * Examples
 * --------
 *   bun run electron:open
 *   PORT=3179 bun run electron:open
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT ?? 3000);
// Use `localhost` — not `127.0.0.1` — so the renderer's origin matches
// what a normal Chrome tab pointed at the same dev server would use.
// Chromium isolates Storage (localStorage, IndexedDB, Cookies) by
// origin string, treating `http://localhost:3000` and
// `http://127.0.0.1:3000` as different origins even though they
// resolve to the same socket. Same hostname → same localStorage.
const HOST = "localhost";
const BASE = `http://${HOST}:${PORT}`;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 1500);

/**
 * Resolves true if something is listening on the port AND answers an
 * HTTP request within the timeout. We only need any non-5xx response;
 * Next dev's default 200/307 on `/` both count. Anything else (ECONNREFUSED,
 * timeout, non-HTTP server) → assume "no Claudius dev server here".
 */
function isReachable(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: "/", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        resolve(code > 0 && code < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Runs a command, inheriting stdio. Resolves to its exit code. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: REPO_ROOT,
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // SIGINT (Ctrl+C) is the normal way to tear down the launcher —
      // don't treat it as an error.
      if (signal === "SIGINT") {
        resolve(0);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function compileElectron() {
  console.log("[electron:open] compiling dist-electron/…");
  const code = await run("bun", ["run", "electron:compile"]);
  if (code !== 0) process.exit(code);
}

async function attachToExisting() {
  console.log(`[electron:open] found dev server at ${BASE} — attaching Electron`);
  await compileElectron();
  // Launch electron directly; no rebuild — the running Next has its
  // native .node already loaded in memory and that's what matters.
  const code = await run("electron", ["dist-electron/main.js"], {
    env: {
      ...process.env,
      ELECTRON_START_URL: BASE,
    },
  });
  process.exit(code);
}

async function spawnFreshStack() {
  console.log(`[electron:open] no dev server at ${BASE} — starting next dev + electron`);

  // We need Node ABI for the new `next dev` child. `electron:rebuild-native-for-node`
  // is idempotent — if the lockfile already says `node`, it's a no-op cost.
  console.log("[electron:open] ensuring better-sqlite3 is built for Node ABI…");
  const rebuildCode = await run("bun", ["run", "electron:rebuild-native-for-node"]);
  if (rebuildCode !== 0) process.exit(rebuildCode);

  await compileElectron();

  // Match the `electron:dev` script's concurrently invocation: prefix
  // streams, kill all on Ctrl+C, wait on the http endpoint before
  // spawning Electron so the renderer doesn't hit a blank `connection
  // refused` on first paint.
  console.log("[electron:open] launching concurrently next + electron…");
  const code = await run("bunx", [
    "concurrently",
    "-k",
    "-n",
    "next,electron",
    "-c",
    "blue,magenta",
    `bun run dev`,
    `wait-on ${BASE} && cross-env ELECTRON_START_URL=${BASE} electron dist-electron/main.js`,
  ]);
  process.exit(code);
}

async function main() {
  const reachable = await isReachable(PORT);
  if (reachable) {
    await attachToExisting();
  } else {
    await spawnFreshStack();
  }
}

main().catch((err) => {
  console.error("[electron:open] failed:", err);
  process.exit(1);
});
