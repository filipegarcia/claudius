import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { customizationSrcDir } from "./customizations-store";
import { ensureNodeModulesMirror } from "./customization-bootstrap";

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

const entries = new Map<string, Entry>();

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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

async function pickFreePort(): Promise<number> {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in ${PORT_START}-${PORT_END}`);
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
  const port = await pickFreePort();

  // Spawn `node_modules/.bin/next dev -p <port>` directly — faster than `npx`
  // and avoids the npx network check.
  const nextBin = join(srcDir, "node_modules", ".bin", "next");
  const child = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: srcDir,
    env: {
      ...process.env,
      // Disable Next telemetry banner spam in the preview logs.
      NEXT_TELEMETRY_DISABLED: "1",
      // Avoid the preview process re-using the parent's port if a parent env
      // var leaked through.
      PORT: String(port),
    },
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
