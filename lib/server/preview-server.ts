import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createServer } from "node:net";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { customizationSrcDir } from "./customizations-store";
import { ensureNodeModulesMirror } from "./customization-bootstrap";

const execFileP = promisify(execFile);

/**
 * Manages auto-spawned `next dev` processes for customization previews.
 *
 * Each customization gets at most one running preview. The child runs Next
 * inside the customization's `src/` mirror, so the user can browse a live,
 * fully-isolated copy of their edited Claudius without affecting the running
 * instance.
 *
 * Lifecycle is in-memory only — Claudius restarting kills any running
 * previews (registered as a process exit handler). State is intentionally not
 * persisted: a stale port reservation across restarts is worse than asking
 * the user to click "Start preview" again.
 */

type Status = "starting" | "ready" | "exited" | "error";

type Entry = {
  customizationId: string;
  port: number;
  child: ChildProcess;
  status: Status;
  startedAt: number;
  /** Tail of stdout/stderr lines (bounded). */
  logs: string[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  errorMessage?: string;
};

const PORT_START = 3100;
const PORT_END = 3199;
const LOG_TAIL_MAX = 200;

declare global {
  var __claudiusPreviewEntries: Map<string, Entry> | undefined;
}

// Survive Next dev's hot-module-reload of this file. Without globalThis the
// Map gets re-initialised when preview-server.ts is edited, losing track of
// running preview processes — the user clicks Restart, we don't see the old
// entry, and an orphan keeps holding the port.
const entries: Map<string, Entry> =
  globalThis.__claudiusPreviewEntries ??
  (globalThis.__claudiusPreviewEntries = new Map<string, Entry>());

function pushLog(e: Entry, line: string): void {
  // Strip trailing newlines; split on newlines so a chunk doesn't squash
  // multiple lines into one log entry.
  for (const part of line.split(/\r?\n/)) {
    if (!part) continue;
    e.logs.push(part);
    if (e.logs.length > LOG_TAIL_MAX) e.logs.splice(0, e.logs.length - LOG_TAIL_MAX);
    // Cheap "ready" detection — Next prints "Ready" or "started server" once
    // its dev server is listening. Avoids us claiming "starting" forever.
    if (e.status === "starting" && /\b(ready|started server|listening)\b/i.test(part)) {
      e.status = "ready";
    }
  }
}

/**
 * True if the port is bindable on every interface Next dev cares about.
 * `next dev -p N` listens on `::` (IPv6 all-interfaces); a check against
 * 127.0.0.1 alone misses ports already bound on that side and produces
 * false-positives that cascade into EADDRINUSE at spawn time. We bind
 * without a host (Node defaults to dualstack `::` when available) and
 * fail-fast if either interface is taken.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    // `host: undefined` → Node binds dualstack on `::` where supported.
    srv.listen({ port, exclusive: true });
  });
}

async function pickFreePort(): Promise<number> {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in ${PORT_START}-${PORT_END}`);
}

/**
 * Find the PIDs holding a TCP listening socket on `port`. macOS / Linux
 * both ship `lsof`; if it isn't on PATH the function returns an empty
 * array and the caller falls back to picking a different port.
 */
async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP("lsof", ["-nP", "-iTCP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: 3_000,
    });
    return stdout
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Kill any listeners across the whole preview port range whose PIDs we
 * don't currently own. Belt-and-suspenders for orphaned Next dev workers
 * left over from prior crashes / HMR resets / dev-server restarts.
 *
 * CRUCIAL: never kill ourselves. The main Claudius dev server's port (3179
 * by default) lives inside the preview port range, so its PID would
 * otherwise show up as "unowned" and get reaped — which would shoot down
 * the very process running this code.
 */
async function sweepStaleListeners(): Promise<number> {
  const ownedPids = new Set<number>();
  for (const e of entries.values()) {
    if (e.child.pid) ownedPids.add(e.child.pid);
  }
  // Self-protection: this process and its direct parent (the `next dev`
  // wrapper that spawned the bundler worker) must never be killed by the
  // sweep. process.ppid is reliable on POSIX; on Windows it's still
  // populated by Node.
  ownedPids.add(process.pid);
  if (typeof process.ppid === "number" && process.ppid > 0) {
    ownedPids.add(process.ppid);
  }
  let killed = 0;
  for (let p = PORT_START; p <= PORT_END; p++) {
    const pids = await pidsOnPort(p);
    for (const pid of pids) {
      if (ownedPids.has(pid)) continue;
      try {
        process.kill(pid, "SIGTERM");
        killed++;
      } catch {
        // ignore — not ours
      }
    }
  }
  if (killed > 0) {
    await new Promise((res) => setTimeout(res, 800));
    for (let p = PORT_START; p <= PORT_END; p++) {
      for (const pid of await pidsOnPort(p)) {
        if (ownedPids.has(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  }
  return killed;
}

async function killSquatters(port: number): Promise<number> {
  const pids = await pidsOnPort(port);
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      // not our process, or already gone
    }
  }
  if (killed === 0) return 0;
  // Give them a moment to release the port, then SIGKILL anyone still alive.
  await new Promise((res) => setTimeout(res, 800));
  for (const pid of await pidsOnPort(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return killed;
}


/**
 * Locate a directory containing a `node` executable for the preview child.
 *
 * Turbopack spawns a `node` "pooled process" to evaluate the PostCSS/Tailwind
 * loader; if `node` isn't on the child's PATH the dev server 500s with
 * "spawning node pooled process: No such file or directory". The Claudius
 * standalone parent runs under Electron with a minimal PATH that usually has
 * no `node`, so we resolve one explicitly and prepend its dir to the child PATH.
 *
 * Returns null when no system `node` is found — the packaged/shipped app has no
 * system node and needs an Electron-as-node shim instead (handled separately);
 * in a dev checkout one of these locations resolves.
 */
function resolveNodeDir(): string | null {
  // 0. The node we ship for exactly this purpose (packaged app). Turbopack's
  //    PostCSS worker crashes under Electron-as-node (@tailwindcss/oxide
  //    SIGTRAPs on Electron's V8), so the packaged app bundles a REAL node at
  //    <Resources>/preview-runtime/node — prefer it above everything.
  const bundled = bundledRuntimeDir();
  if (bundled && existsSync(join(bundled, "node"))) return bundled;
  // 1. Already running under Node → reuse its dir (the web dev / `next start`
  //    case where process.execPath IS node).
  try {
    if (basename(process.execPath).toLowerCase().startsWith("node")) {
      return dirname(process.execPath);
    }
  } catch {
    // fall through to PATH scan
  }
  // 2. A `node` already resolvable on the inherited PATH.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "node"))) return dir;
  }
  // 3. Common install locations (Homebrew arm64/x64, /usr/local, system).
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    if (existsSync(join(dir, "node"))) return dir;
  }
  return null;
}

/**
 * The dir holding the binaries bundled specifically for the preview runtime
 * (`node`, `bun`), shipped at `<app>/Contents/Resources/preview-runtime` via
 * electron-builder extraResources. `process.resourcesPath` is only set in a
 * packaged Electron app; in dev this returns null and callers fall back to a
 * system runtime.
 */
function bundledRuntimeDir(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resources) return null;
  return join(resources, "preview-runtime");
}

/**
 * Resolve a `bun` binary to install the mirror's dev dependencies on first
 * preview: the packaged mirror hardlinks the app's SLIM standalone
 * node_modules, which lacks the dev toolchain (`next dev` CLI, the Tailwind
 * v4 PostCSS chain, client-only deps). Prefer the bundled bun, then the user's.
 */
function resolveBun(): string | null {
  const bundled = bundledRuntimeDir();
  if (bundled && existsSync(join(bundled, "bun"))) return join(bundled, "bun");
  const home = process.env.HOME ?? "";
  const homeBun = home ? join(home, ".bun", "bin", "bun") : "";
  if (homeBun && existsSync(homeBun)) return homeBun;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "bun"))) return join(dir, "bun");
  }
  return null;
}

/**
 * True when the mirror already has the dev toolchain needed to run `next dev`
 * (the dev CLI + the Tailwind v4 PostCSS plugin). In a dev checkout the mirror
 * hardlinks a complete node_modules, so this is true and no install runs. In a
 * packaged app the standalone node_modules is stripped, so this is false on the
 * first preview and we `bun install` to complete it.
 */
function mirrorDepsComplete(srcDir: string): boolean {
  return (
    existsSync(join(srcDir, "node_modules", "next", "dist", "cli", "next-dev.js")) &&
    existsSync(join(srcDir, "node_modules", "@tailwindcss", "postcss"))
  );
}

/**
 * Ensure the mirror has a full dev dependency tree. No-op when already complete
 * (every dev-checkout preview, and every preview after the first in a packaged
 * app). On first packaged preview, runs `bun install` in the mirror — slow
 * (~30-90s, needs network once) but leverages bun's global cache thereafter.
 * Returns a status line for the caller to surface, or null when nothing ran.
 */
function ensureMirrorDeps(srcDir: string): string | null {
  if (mirrorDepsComplete(srcDir)) return null;
  const bun = resolveBun();
  if (!bun) {
    return "cannot complete preview dependencies: no `bun` found (install bun or run from source)";
  }
  const res = spawnSync(bun, ["install"], {
    cwd: srcDir,
    stdio: ["ignore", "pipe", "pipe"],
    // Scrub the same leaked parent env that wedges the dev server.
    env: buildPreviewEnv(0),
    timeout: 5 * 60_000,
  });
  if (res.status !== 0) {
    const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
    return `bun install failed (code ${res.status}): ${tail}`;
  }
  return "installed preview dependencies";
}

/**
 * Build the env for a spawned `next dev` preview.
 *
 * The Claudius standalone server (this process) injects env vars that, inherited
 * verbatim, break a `next dev` child:
 *  - `__NEXT_PRIVATE_STANDALONE_CONFIG` bakes `turbopack.root` /
 *    `outputFileTracingRoot` to the *build* dir, so `.next` "navigates out of
 *    projectPath" → Turbopack panics (`Invalid distDirRoot`) before serving a
 *    single byte. `__NEXT_PRIVATE_ORIGIN` / `NEXT_DEPLOYMENT_ID` are similar
 *    standalone-runtime hints.
 *  - `CLAUDIUS_PACKAGED=1` flips the mirror's copied `next.config.ts` to
 *    `output:"standalone"`, which is wrong for a dev server. `CLAUDIUS_ELECTRON`
 *    makes the mirror's server-side `isElectron()` true — but the preview is a
 *    plain browser tab, so it should behave as the web build.
 *  - `NODE_ENV=production` silently disables Fast Refresh — the whole point of a
 *    preview is edit→hot-reload, so force `development`.
 *  - `TURBOPACK` is dropped (Turbopack is the dev default anyway; a stray value
 *    only risks clashing with an explicit bundler flag).
 * Finally prepend a real `node` dir to PATH so Turbopack's PostCSS pool can spawn.
 */
function buildPreviewEnv(port: number): NodeJS.ProcessEnv {
  // A mutable record — `NodeJS.ProcessEnv` types `NODE_ENV` as read-only, which
  // blocks the reassignment below.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("__NEXT_PRIVATE_")) delete env[key];
  }
  delete env.TURBOPACK;
  delete env.CLAUDIUS_PACKAGED;
  delete env.CLAUDIUS_ELECTRON;
  delete env.NEXT_DEPLOYMENT_ID;
  env.NODE_ENV = "development";
  // Disable Next telemetry banner spam in the preview logs.
  env.NEXT_TELEMETRY_DISABLED = "1";
  // Pin the port so a leaked parent PORT can't redirect the child.
  env.PORT = String(port);

  const nodeDir = resolveNodeDir();
  if (nodeDir) {
    env.PATH = env.PATH ? `${nodeDir}${delimiter}${env.PATH}` : nodeDir;
  }
  // NODE_ENV is set above, so the cast to ProcessEnv (which requires it) is safe.
  return env as NodeJS.ProcessEnv;
}

export type PreviewState = {
  customizationId: string;
  status: Status;
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  errorMessage?: string;
  logs: string[];
};

function snapshot(e: Entry | undefined, customizationId: string): PreviewState {
  if (!e) {
    return {
      customizationId,
      status: "exited",
      port: null,
      pid: null,
      startedAt: null,
      exitCode: null,
      exitSignal: null,
      logs: [],
    };
  }
  return {
    customizationId: e.customizationId,
    status: e.status,
    port: e.port,
    pid: e.child.pid ?? null,
    startedAt: e.startedAt,
    exitCode: e.exitCode,
    exitSignal: e.exitSignal,
    errorMessage: e.errorMessage,
    logs: e.logs.slice(),
  };
}

export function getPreviewState(customizationId: string): PreviewState {
  return snapshot(entries.get(customizationId), customizationId);
}

export async function startPreview(customizationId: string): Promise<PreviewState> {
  const existing = entries.get(customizationId);
  if (existing && (existing.status === "starting" || existing.status === "ready")) {
    return snapshot(existing, customizationId);
  }
  // If we tracked a previous run that's now exited, drop the entry first so
  // a fresh log buffer + status starts clean instead of reading "exited".
  if (existing) entries.delete(customizationId);

  const srcDir = customizationSrcDir(customizationId);
  // Sanity: src must exist (bootstrap creates it).
  try {
    const st = await fs.stat(srcDir);
    if (!st.isDirectory()) throw new Error(`${srcDir} is not a directory`);
  } catch {
    throw new Error(`customization ${customizationId} has no src/ dir`);
  }
  // Self-heal: customizations created before the hardlink-tree fix have a
  // stale symlink at <src>/node_modules that Turbopack rejects. The mirror
  // function detects + replaces it.
  await ensureNodeModulesMirror(srcDir);

  // Complete the mirror's dev dependency tree if needed (packaged first
  // preview): the shipped standalone node_modules is stripped of the dev
  // toolchain, so `bun install` runs once. No-op in a dev checkout. Captured
  // here and surfaced in the entry logs once it exists.
  const depMsg = ensureMirrorDeps(srcDir);

  // If the previous Next dev process left a grandchild (worker) bound to its
  // port, our port-free probe correctly skips it now that we bind on `::` —
  // but if THIS customization's previous port still has a squatter (e.g.
  // user manually restarted the dev server while a preview was open), reap
  // it so we can keep using the same port. This is the "kill the old one"
  // affordance: callers don't need to know about orphaned grandchildren.
  if (existing?.port) {
    await killSquatters(existing.port).catch(() => 0);
  }
  const port = await pickFreePort();
  // Final defensive sweep on the chosen port — handles the rare case where
  // something raced in between the probe and the spawn.
  await killSquatters(port).catch(() => 0);

  // Spawn `node_modules/.bin/next dev -p <port>` directly — faster than `npx`
  // and avoids the npx network check.
  const nextBin = join(srcDir, "node_modules", ".bin", "next");
  const child = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: srcDir,
    // A scrubbed, development env — inheriting the Claudius standalone parent's
    // env verbatim wedges `next dev` (see buildPreviewEnv).
    env: buildPreviewEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry: Entry = {
    customizationId,
    port,
    child,
    status: "starting",
    startedAt: Date.now(),
    logs: [],
    exitCode: null,
    exitSignal: null,
  };
  entries.set(customizationId, entry);
  if (depMsg) pushLog(entry, `[deps] ${depMsg}`);

  child.stdout?.on("data", (buf: Buffer) => pushLog(entry, buf.toString("utf8")));
  child.stderr?.on("data", (buf: Buffer) => pushLog(entry, buf.toString("utf8")));
  child.once("error", (err) => {
    entry.status = "error";
    entry.errorMessage = err instanceof Error ? err.message : String(err);
    pushLog(entry, `[spawn error] ${entry.errorMessage}`);
  });
  child.once("exit", (code, signal) => {
    entry.status = "exited";
    entry.exitCode = code;
    entry.exitSignal = signal;
    pushLog(entry, `[exit] code=${code} signal=${signal ?? "-"}`);
  });

  return snapshot(entry, customizationId);
}

export async function stopPreview(customizationId: string): Promise<PreviewState> {
  const entry = entries.get(customizationId);
  if (!entry) return snapshot(undefined, customizationId);
  if (entry.status === "exited" || entry.status === "error") {
    return snapshot(entry, customizationId);
  }
  entry.child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!entry.child.killed) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 5000);
  // Don't keep the event loop alive for the kill timer.
  killTimer.unref?.();
  return snapshot(entry, customizationId);
}

/**
 * Stop any running preview, wait for the OS to release the port (Next dev's
 * worker grandchild can outlive the parent process by a few hundred ms), then
 * start a fresh one. Used when the user hits "Restart preview" from the UI.
 */
export async function restartPreview(customizationId: string): Promise<PreviewState> {
  const existing = entries.get(customizationId);
  if (existing && (existing.status === "starting" || existing.status === "ready")) {
    await stopPreview(customizationId);
    // Give SIGTERM a moment to propagate to the worker grandchild.
    await new Promise((res) => setTimeout(res, 600));
  }
  // Reap anything still bound to the old port — handles workers that
  // survived the parent's SIGTERM.
  if (existing?.port) {
    await killSquatters(existing.port).catch(() => 0);
  }
  // Sweep the rest of the preview port range for orphans we don't own
  // (e.g. previews from before an HMR reset of this module). Without this,
  // an HMR-orphaned preview keeps :3100 forever and every restart picks a
  // new port until the range is exhausted.
  await sweepStaleListeners().catch(() => 0);
  // Drop the old tracker so startPreview produces a fresh log buffer.
  entries.delete(customizationId);
  return startPreview(customizationId);
}

export function listPreviews(): PreviewState[] {
  return Array.from(entries.entries()).map(([id, e]) => snapshot(e, id));
}

let exitHooksRegistered = false;
export function registerExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  const cleanup = () => {
    for (const e of entries.values()) {
      if (e.status !== "exited" && e.status !== "error") {
        try {
          e.child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

// Auto-register on first import — so even routes that never touch
// preview-server's exports won't leave orphans behind during dev restarts.
registerExitHooks();
