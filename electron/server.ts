/**
 * Boot the Next.js standalone server as a CHILD PROCESS of Electron.
 *
 * The previous shape (Phase 1) loaded Next in the main process via
 *     const next = require("next");
 *     await next({ dev:false, dir }).prepare();
 * That ran ~2-4s of synchronous module loading + route preparation on
 * the main process event loop. While it ran, IPC to the splash window's
 * renderer was starved (dock bounced, splash painted sluggishly), no
 * other window could be created, and the OS menu had to wait. The user
 * perceived a "frozen" cold start.
 *
 * Current shape: spawn `<appDir>/server.js` (Next's `output: 'standalone'`
 * entry) in a child process. The child does the heavy `require("next")`
 * + `startServer()` in its own V8 isolate, so the main process stays
 * free to pump the splash, install the menu, register IPC handlers, and
 * create the BrowserWindow in parallel.
 *
 * macOS dock-icon gotcha: spawning `process.execPath` directly (the main
 * Claudius binary) makes the child inherit the .app bundle's Info.plist,
 * which has no `LSUIElement` — so macOS gives the child its own Dock
 * entry (a generic "exec" icon alongside the real Claudius). The
 * Electron Helper binary at
 *   `Contents/Frameworks/Claudius Helper.app/Contents/MacOS/Claudius Helper`
 * has `LSUIElement=true` baked into its Info.plist and inherits the
 * same entitlements via electron-builder.yml's `entitlementsInherit`,
 * so it's a drop-in substitute that stays invisible in the Dock /
 * Cmd-Tab. We use it on packaged macOS and fall back to
 * `process.execPath` everywhere else (dev, smoke, Linux, Windows).
 *
 * In both cases the child runs with `ELECTRON_RUN_AS_NODE=1`, which
 * flips the Electron binary into headless-Node mode — no Chromium, no
 * display surface, no app lifecycle.
 *
 * Native modules: `bun run electron:rebuild-native` (run before every
 * packaged build) rebuilds better-sqlite3 against the Electron ABI.
 * `ELECTRON_RUN_AS_NODE` uses the SAME ABI, so the standalone tree's
 * bundled .node files load in the child without another rebuild.
 *
 * Readiness is detected by TCP-probing the bound port — no stdout
 * scraping, no log-format coupling. The child's stdout/stderr is
 * forwarded to the main process's console with a `[next-server]`
 * prefix so packaged-build logs stay debuggable.
 *
 * In dev (`bun run electron:dev`), the renderer is pointed at the
 * already-running `next dev` on :3000 via `ELECTRON_START_URL` and this
 * module is NOT used. Only the packaged build (and the smoke test) need
 * the embedded server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import path from "node:path";

export type EmbeddedNextServer = {
  url: string;
  /** The actual port the child server is listening on. */
  port: number;
  close: () => Promise<void>;
};

// Probe the child's port every 50ms; bail out after 30s. The standalone
// server boots in ~500-2000ms on a warm cache, so 50ms is a generous
// granularity that loses at most one probe-tick of perceived latency.
const READY_PROBE_INTERVAL_MS = 50;
const READY_PROBE_TIMEOUT_MS = 30_000;
// SIGTERM the child on app quit, then SIGKILL after this many ms if it
// hasn't exited. The standalone server's startServer() catches SIGTERM
// and closes gracefully; 3s is plenty of headroom for that path.
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * One-shot TCP probe — try to open a connection to `port` on the loopback
 * interface; resolve true iff the connection was accepted before either
 * side gave up. Used both to test whether the preferred port is already
 * in use AND to detect when the standalone child has finished binding.
 */
function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilListening(port: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await probePort(port)) return;
    await new Promise<void>((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
  }
  throw new Error(`embedded server did not bind ${port} within ${deadlineMs}ms`);
}

/**
 * Ask the kernel for an unused ephemeral port by binding a throwaway
 * server to :0, reading the assigned port, and closing. There's an
 * inherent race — between us closing the listener and the standalone
 * child re-binding the same port, another process *could* grab it —
 * but that race window is microseconds and was acceptable in the
 * previous in-process implementation, so we keep it.
 */
function pickEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("could not assign ephemeral port"));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Resolve `<appDir>/server.js` and bail with a clear message if the
 * standalone tree is missing — easier to diagnose than a child-process
 * spawn ENOENT, which surfaces as a generic exit code.
 */
async function ensureServerJsExists(serverPath: string): Promise<void> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(serverPath);
  } catch {
    throw new Error(
      `standalone server entry not found at ${serverPath} — was the build run with output: 'standalone'?`,
    );
  }
}

/**
 * Resolve which binary to spawn the standalone server with.
 *
 * On packaged macOS this is the Electron Helper binary — NOT the main
 * `Contents/MacOS/Claudius` binary. The two differ in one critical way:
 * the Helper's `Info.plist` has `LSUIElement=true` so any process spawned
 * from it is invisible to the Dock/Cmd-Tab. The main binary inherits the
 * app bundle's Info.plist, which (correctly) has no LSUIElement so the
 * Claudius window appears in the Dock. Spawning the main binary as the
 * child means that child also gets a Dock entry — a second bouncing
 * "Claudius" icon with a generic green `exec` glyph next to the real
 * app. Switching to the Helper kills the duplicate.
 *
 * Same Node runtime, same ELECTRON_RUN_AS_NODE behavior, same ABI for
 * the bundled .node files, same entitlements (electron-builder.yml's
 * `entitlementsInherit` applies build/entitlements.mac.plist to all
 * nested binaries). Only the visibility surface changes.
 *
 * Everywhere else (dev, smoke, Linux, Windows) we use `process.execPath`
 * directly — there's no Dock to pollute, and the Helper layout is
 * macOS-specific anyway.
 */
function resolveSpawnExecutable(): string {
  if (process.platform !== "darwin" || process.env.CLAUDIUS_PACKAGED !== "1") {
    return process.execPath;
  }
  // process.execPath is `<app>/Contents/MacOS/Claudius`.
  // The Helper lives at `<app>/Contents/Frameworks/Claudius Helper.app/
  //   Contents/MacOS/Claudius Helper`.
  // We derive both paths from execPath so the resolution survives any
  // electron-builder rename (productName change → Helper name follows).
  const macOsDir = path.dirname(process.execPath);
  const appName = path.basename(process.execPath); // e.g. "Claudius"
  return path.resolve(
    macOsDir,
    "..",
    "Frameworks",
    `${appName} Helper.app`,
    "Contents",
    "MacOS",
    `${appName} Helper`,
  );
}

/**
 * Boot the Next.js standalone server in a child process and wait for it
 * to start accepting connections. Returns once the port is bound.
 *
 * Port resolution: try `preferredPort` first (so localStorage stays
 * stable across launches — see `electron/main.ts:resolveStartUrl`), but
 * if something is already bound there, fall back to a kernel-chosen
 * ephemeral port. The caller is responsible for persisting whatever
 * port we resolve so the next launch can request the SAME port.
 */
export async function startEmbeddedNextServer(
  appDir: string,
  preferredPort?: number,
): Promise<EmbeddedNextServer> {
  const serverPath = path.join(appDir, "server.js");
  await ensureServerJsExists(serverPath);

  // Decide the port BEFORE spawning the child so we know what to probe.
  // Probing the preferred port returns true iff something is already
  // bound, in which case we skip straight to a random ephemeral port.
  let port = preferredPort;
  if (port == null || !Number.isFinite(port) || (await probePort(port))) {
    if (preferredPort != null) {
      console.warn(
        `[electron/server] preferred port ${preferredPort} unavailable, falling back to random`,
      );
    }
    port = await pickEphemeralPort();
  }

  // Build the child's environment. ELECTRON_RUN_AS_NODE=1 is the magic
  // flag that turns the Electron binary (or Helper) into a headless Node
  // runtime. PORT and HOSTNAME are the standalone server.js's
  // documented configuration knobs.
  //
  // We delete the Electron-renderer-specific vars Chromium injects into
  // its own children (ELECTRON_NO_ATTACH_CONSOLE, etc.) — harmless if
  // they hang around but cleaner to drop them.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
  };
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete childEnv.ELECTRON_NO_ASAR;

  const spawnExec = resolveSpawnExecutable();

  // stdio: ignore stdin (the child doesn't read it), pipe stdout/stderr
  // so we can forward log lines with a prefix. `windowsHide: true` keeps
  // a console flash from appearing on Windows packaged builds — no
  // effect on macOS/Linux but cheap insurance.
  const child: ChildProcess = spawn(spawnExec, [serverPath], {
    cwd: appDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[next-server] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next-server] ${chunk}`);
  });

  // Track the child's exit state. If it dies before we see a ready
  // signal, that's a fatal startup error — surface it instead of waiting
  // the full READY_PROBE_TIMEOUT_MS only to time out with no context.
  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let exited = false;
  const exitWaiters: Array<() => void> = [];
  child.once("exit", (code, signal) => {
    exited = true;
    earlyExit = { code, signal };
    if (code !== 0) {
      console.error(
        `[electron/server] child server exited code=${code} signal=${signal ?? "<none>"}`,
      );
    }
    for (const w of exitWaiters.splice(0)) w();
  });

  // Wait for either a successful TCP probe OR the child to exit early.
  // Whichever happens first wins.
  try {
    const readyPromise = waitUntilListening(port, READY_PROBE_TIMEOUT_MS);
    const earlyExitPromise = new Promise<never>((_, reject) => {
      exitWaiters.push(() =>
        reject(
          new Error(
            `embedded server exited early (code=${earlyExit?.code}, signal=${earlyExit?.signal ?? "<none>"}) before binding port ${port}`,
          ),
        ),
      );
    });
    await Promise.race([readyPromise, earlyExitPromise]);
  } catch (err) {
    // If the child is still up but never bound, kill it before
    // re-throwing so the caller doesn't leak a zombie process.
    if (!exited && child.pid != null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead — fine.
      }
    }
    throw err;
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if (exited || child.pid == null) {
          resolve();
          return;
        }
        // The child catches SIGTERM and closes the HTTP listener
        // gracefully. If it ignores us (corrupt state, hung handle), we
        // SIGKILL after SHUTDOWN_GRACE_MS so app quit doesn't hang.
        const grace = setTimeout(() => {
          if (!exited) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Race with natural exit — ignore.
            }
          }
        }, SHUTDOWN_GRACE_MS);
        grace.unref();
        child.once("exit", () => {
          clearTimeout(grace);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          // Process is already gone — exit handler fires immediately.
        }
      }),
  };
}

/**
 * Resolve the standalone tree root. `server.js` lives directly inside
 * this directory.
 *
 * Packaged: electron-builder copies `.next/standalone/` verbatim to
 * `<app>/Contents/Resources/standalone` (see `electron-builder.yml`'s
 * extraResources block) so the tree's own node_modules and unpacked
 * `.node` files survive packaging and load at runtime.
 *
 * Dev / smoke: this file compiles to `dist-electron/server.js` one
 * level beneath the project root, so we resolve to
 * `<project-root>/.next/standalone`. `bun run build` (or
 * `electron:smoke`'s build step) writes the standalone tree there.
 *
 * The old in-process Phase 1 returned the directory CONTAINING `.next/`
 * — `<project-root>` for dev, `<resources>/standalone` for packaged. We
 * unified on the standalone-tree-root semantics so `path.join(appDir,
 * "server.js")` always resolves to the spawn target.
 */
export function defaultAppDir(): string {
  if (process.env.CLAUDIUS_PACKAGED === "1") {
    return path.join(process.resourcesPath, "standalone");
  }
  return path.resolve(__dirname, "..", ".next", "standalone");
}
