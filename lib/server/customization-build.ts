import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { arch as hostArch } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { customizationDir, customizationSrcDir, getCustomization } from "./customizations-store";
import { computeDiff } from "./customization-publish";
import { getLiveSourceDir } from "./runtime-dir";

/**
 * "Build installable app" — spawn `scripts/build-app-local.mjs` with a
 * customization's edits baked in, producing a Claudius.app on disk with the
 * customization applied (without publishing it into the running app).
 *
 * The build runs in the SOURCE checkout (`getLiveSourceDir()`), which must
 * contain the build script + electron-builder config. A truly read-only
 * shipped app with no source tree can't build locally — callers get a clear
 * error (`buildAvailability()`), and the UI hides the action there.
 *
 * State is in-memory only (one build at a time per customization), mirroring
 * the preview server: a build takes minutes, and a stale record across a
 * restart is worse than asking the user to click again.
 */

type Status = "building" | "done" | "error";

type Entry = {
  customizationId: string;
  status: Status;
  startedAt: number;
  finishedAt: number | null;
  child: ChildProcess | null;
  logs: string[];
  artifactPath: string | null;
  errorMessage?: string;
};

const LOG_TAIL_MAX = 400;

declare global {
  var __claudiusBuildEntries: Map<string, Entry> | undefined;
}

const entries: Map<string, Entry> =
  globalThis.__claudiusBuildEntries ??
  (globalThis.__claudiusBuildEntries = new Map<string, Entry>());

function macSubdir(): string {
  return hostArch() === "arm64" ? "mac-arm64" : "mac";
}

/** Absolute path to the build script in the source checkout, or null if absent. */
function buildScriptPath(): string | null {
  const live = getLiveSourceDir();
  const script = join(live, "scripts", "build-app-local.mjs");
  const ebYaml = join(live, "electron-builder.yml");
  if (existsSync(script) && existsSync(ebYaml)) return script;
  return null;
}

/** Whether a local build is possible in this runtime (source tree present). */
export function buildAvailability(): { available: boolean; reason?: string } {
  if (!buildScriptPath()) {
    return {
      available: false,
      reason: "Local build needs the Claudius source checkout — run from source (electron:dev) to enable it.",
    };
  }
  return { available: true };
}

/**
 * Resolve a runtime to launch the build script (a `.mjs`). The packaged app's
 * PATH usually lacks `node`; fall back to common install dirs, then bun.
 */
function resolveLauncher(): { bin: string; nodeDir: string | null } | null {
  try {
    if (basename(process.execPath).toLowerCase().startsWith("node")) {
      return { bin: process.execPath, nodeDir: dirname(process.execPath) };
    }
  } catch {
    // fall through
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "node"))) return { bin: join(dir, "node"), nodeDir: dir };
  }
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    if (existsSync(join(dir, "node"))) return { bin: join(dir, "node"), nodeDir: dir };
  }
  // Last resort: bun can execute the .mjs too.
  const bun = join(process.env.HOME ?? "", ".bun", "bin", "bun");
  if (existsSync(bun)) return { bin: bun, nodeDir: dirname(bun) };
  return null;
}

export type BuildState = {
  customizationId: string;
  status: Status;
  startedAt: number;
  finishedAt: number | null;
  artifactPath: string | null;
  errorMessage?: string;
  logs: string[];
};

function snapshot(e: Entry | undefined, customizationId: string): BuildState {
  if (!e) {
    return {
      customizationId,
      status: "done",
      startedAt: 0,
      finishedAt: null,
      artifactPath: null,
      logs: [],
    };
  }
  return {
    customizationId: e.customizationId,
    status: e.status,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    artifactPath: e.artifactPath,
    errorMessage: e.errorMessage,
    logs: e.logs.slice(),
  };
}

export function getBuildState(customizationId: string): BuildState | null {
  const e = entries.get(customizationId);
  return e ? snapshot(e, customizationId) : null;
}

function pushLog(e: Entry, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    e.logs.push(line);
    if (e.logs.length > LOG_TAIL_MAX) e.logs.splice(0, e.logs.length - LOG_TAIL_MAX);
  }
}

/**
 * Start a build for `customizationId`. Computes the overlay (changed + added
 * files vs live), writes the manifest, and spawns the build script with the
 * overlay flags. Returns immediately with a "building" state; poll
 * `getBuildState` for progress.
 */
export async function startBuild(customizationId: string): Promise<BuildState> {
  const existing = entries.get(customizationId);
  if (existing && existing.status === "building") {
    return snapshot(existing, customizationId);
  }

  const cust = await getCustomization(customizationId);
  if (!cust) throw new Error("customization not found");

  const script = buildScriptPath();
  if (!script) throw new Error(buildAvailability().reason ?? "local build unavailable");

  const launcher = resolveLauncher();
  if (!launcher) throw new Error("no node/bun runtime found to run the build");

  // Compute the overlay file list (added + changed) and persist it.
  const diff = await computeDiff(customizationId);
  const overlayPaths = diff.files.map((f) => f.path);
  const manifestFile = join(customizationDir(customizationId), ".build-overlay.txt");
  await fs.mkdir(dirname(manifestFile), { recursive: true });
  await fs.writeFile(manifestFile, overlayPaths.join("\n") + "\n", "utf8");

  const srcDir = customizationSrcDir(customizationId);
  const live = getLiveSourceDir();
  const artifactPath = join(live, "release", macSubdir(), "Claudius.app");

  // Scrub the leaked standalone-parent env — the build script strips these too,
  // but keep the child clean from the start. `node` dir is ensured on PATH.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("__NEXT_PRIVATE_")) delete env[key];
  }
  delete env.NEXT_DEPLOYMENT_ID;
  if (launcher.nodeDir) {
    env.PATH = env.PATH ? `${launcher.nodeDir}${delimiter}${env.PATH}` : launcher.nodeDir;
  }

  const child = spawn(
    launcher.bin,
    [script, "--overlay-src", srcDir, "--overlay-manifest", manifestFile],
    { cwd: live, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
  );

  const entry: Entry = {
    customizationId,
    status: "building",
    startedAt: Date.now(),
    finishedAt: null,
    child,
    logs: [],
    artifactPath: null,
  };
  entries.set(customizationId, entry);

  child.stdout?.on("data", (b: Buffer) => pushLog(entry, b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => pushLog(entry, b.toString("utf8")));
  child.once("error", (err) => {
    entry.status = "error";
    entry.errorMessage = err instanceof Error ? err.message : String(err);
    entry.finishedAt = Date.now();
    pushLog(entry, `[spawn error] ${entry.errorMessage}`);
  });
  child.once("exit", (code) => {
    entry.finishedAt = Date.now();
    if (code === 0 && existsSync(artifactPath)) {
      entry.status = "done";
      entry.artifactPath = artifactPath;
    } else {
      entry.status = "error";
      entry.errorMessage = `build exited with code ${code}${existsSync(artifactPath) ? "" : " (no .app produced)"}`;
    }
  });

  return snapshot(entry, customizationId);
}
