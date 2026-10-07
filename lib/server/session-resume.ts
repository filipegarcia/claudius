import { promises as fs, createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { projectRoot } from "./db";
import { sessionManager } from "./session-manager";
import { info as sessionFileInfo } from "./sessions-store";
import { listWorkspaces, type Workspace } from "./workspaces-store";
import type { Session } from "./session";

function debug(): boolean {
  return !!process.env.CLAUDIUS_DEBUG_SESSIONS;
}

/**
 * The permission mode last recorded in a session's transcript. The engine
 * stamps `permissionMode` on every prompt it writes, and appends a
 * `{type: "permission-mode"}` entry when the mode changes; whichever comes
 * last wins. Subagent (sidechain) lines carry the subagent's own mode and
 * are skipped. Null when nothing is recorded or the file can't be read.
 */
export async function lastRecordedPermissionMode(id: string, cwd: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  const dir = projectRoot(cwd);
  const file = resolve(dir, `${id}.jsonl`);
  if (!file.startsWith(dir + sep)) return null;
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  let last: string | null = null;
  try {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"permissionMode"')) continue;
      let entry: { type?: unknown; permissionMode?: unknown; isSidechain?: unknown };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // torn trailing line mid-write
      }
      if (entry.isSidechain === true) continue;
      if (entry.type !== "user" && entry.type !== "permission-mode") continue;
      if (typeof entry.permissionMode === "string") last = entry.permissionMode;
    }
  } catch {
    return null;
  }
  return last;
}

/**
 * CC 2.1.292 — "Fixed plan mode not being restored when resuming a
 * session". The mode a resumed session should run in when the request
 * didn't name one: `plan` if the session was in plan mode — live in memory,
 * or (after a reap / server restart) as last recorded in its transcript —
 * otherwise `fallback`, the workspace default, as before.
 *
 * Only plan is carried over, like the CLI: losing it is what lets Claude
 * edit files the user believed were off-limits, and keeping it never widens
 * what the session may do.
 */
export async function resumePermissionMode(
  id: string,
  cwd: string,
  fallback: PermissionMode | undefined,
): Promise<PermissionMode | undefined> {
  const live = sessionManager.get(id);
  const was = live ? live.getPermissionMode() : await lastRecordedPermissionMode(id, cwd);
  return was === "plan" ? "plan" : fallback;
}

/**
 * Look up a Session by id; if it's been reaped from the in-memory map (idle
 * window elapsed with zero SSE subscribers — see `session-manager.ts`), try
 * to rebuild it from the JSONL on disk via `sessionManager.create({ resume:
 * id, ... })`. Applies the originating workspace's defaults the same way
 * `POST /api/sessions` does, so an auto-rebuilt session in (e.g.) a
 * customization workspace doesn't lose its bypass-permissions default.
 *
 * Use this in any `[id]`-keyed route that needs the live Session — without
 * it, polling endpoints like `/context` 404 the moment the reaper runs even
 * though the session is perfectly resumable from disk.
 *
 * Returns null only when there's no JSONL to resume from (truly unknown id).
 */
export async function getOrResumeSession(id: string): Promise<Session | null> {
  const existing = sessionManager.get(id);
  if (existing) {
    if (debug()) {
       
      console.log("[sess-load] getOrResumeSession in-memory hit", { id });
    }
    return existing;
  }
  try {
    const fileInfo = await sessionFileInfo(id);
    if (!fileInfo?.cwd) {
      if (debug()) {
         
        console.warn("[sess-load] getOrResumeSession: no fileInfo/cwd — returning null", {
          id,
          fileInfoFound: !!fileInfo,
        });
      }
      return null;
    }
    if (debug()) {
       
      console.log("[sess-load] getOrResumeSession: resuming from disk", {
        id,
        cwd: fileInfo.cwd,
      });
    }
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const originWs = all.find((w) => w.rootPath === fileInfo.cwd) ?? null;
    const defaults = originWs?.defaults ?? {};
    const permissionMode = await resumePermissionMode(id, fileInfo.cwd, defaults.permissionMode);
    const session = await sessionManager.create({
      resume: id,
      cwd: fileInfo.cwd,
      model: defaults.model,
      permissionMode,
    });
    // Reconcile: an in-memory hit (idempotent resume) doesn't pick up a
    // freshly-changed workspace default — same fix as in POST /api/sessions.
    if (permissionMode && session.getPermissionMode() !== permissionMode) {
      await session.setPermissionMode(permissionMode);
    }
    return session;
  } catch (err) {
    if (debug()) {
       
      console.warn("[sess-load] getOrResumeSession FAILED", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
