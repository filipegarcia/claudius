import { promises as fs, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { projectRoot } from "./db";
import { getSessionState } from "./sessions-db";
import {
  pickRecordedPermissionMode,
  readPermissionModeRecord,
} from "@/lib/shared/permission-mode-record";
import { jsonlLines } from "./jsonl-lines";
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
  return (await lastRecordedPermissionModeAt(id, cwd))?.mode ?? null;
}

/**
 * `lastRecordedPermissionMode` plus when it was recorded: the line's own
 * `timestamp` in epoch ms, or null for an undated line. Only the terminal
 * CLI writes undated `permission-mode` lines (in its metadata re-append,
 * possibly long after the last dated line), so no timestamp in the file
 * bounds when one was written — `pickRecordedPermissionMode` treats it as
 * unknown rather than guessing.
 */
export async function lastRecordedPermissionModeAt(
  id: string,
  cwd: string,
): Promise<{ mode: string; at: number | null } | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  const dir = projectRoot(cwd);
  const file = resolve(dir, `${id}.jsonl`);
  if (!file.startsWith(dir + sep)) return null;
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  let last: { mode: string; at: number | null } | null = null;
  try {
    // `jsonlLines`, not readline: readline splits a record at U+2028/U+2029
    // and the fragments fail to parse (CC 2.1.296).
    for await (const line of jsonlLines(createReadStream(file, "utf8"))) {
      if (!line.includes('"permissionMode"')) continue;
      let entry: {
        type?: unknown;
        permissionMode?: unknown;
        isSidechain?: unknown;
        timestamp?: unknown;
      };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // torn trailing line mid-write
      }
      if (entry.isSidechain === true) continue;
      if (entry.type !== "user" && entry.type !== "permission-mode") continue;
      if (typeof entry.permissionMode === "string") {
        const stamped = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        last = { mode: entry.permissionMode, at: Number.isFinite(stamped) ? stamped : null };
      }
    }
  } catch {
    return null;
  }
  return last;
}

/**
 * CC 2.1.327 — "Added a line when a resumed session's earlier messages can't
 * be loaded". The CLI's copy, shown once at the top of the reopened history.
 */
export const RESUME_GAP_NOTICE =
  "Earlier messages couldn't be loaded because part of this session's file is missing or damaged. Claude won't see them, so repeat anything it still needs.";

/** One transcript row, reduced to what the cut-off rule reads. */
type LinkRow = {
  parent: string | null;
  type: string;
  sidechain: boolean;
  compactSummary: boolean;
  /** File position of the uuid's first occurrence. */
  pos: number;
};

/**
 * The parent links of every uuid-bearing row in a session's JSONL, plus the
 * file position of its first main-chain (non-sidechain) user/assistant row.
 */
export type TranscriptLinks = {
  rows: Map<string, LinkRow>;
  firstTurnPos: number;
};

/** Row types the SDK's chain walk steps through (`getSessionMessages`). */
const CHAIN_TYPES = new Set(["user", "assistant", "progress", "system", "attachment"]);

/**
 * Build {@link TranscriptLinks} from a session's JSONL in one streaming pass.
 * Null when the path is outside `projectsBase` or the file can't be read.
 */
export async function readTranscriptLinks(
  file: string,
  projectsBase: string = join(homedir(), ".claude", "projects"),
): Promise<TranscriptLinks | null> {
  const base = resolve(projectsBase);
  const target = resolve(base, file);
  if (!target.startsWith(base + sep)) return null;
  const rows = new Map<string, LinkRow>();
  try {
    let pos = 0;
    for await (const line of jsonlLines(createReadStream(target, "utf8"))) {
      pos++;
      if (!line.includes('"uuid"')) continue;
      let entry: {
        uuid?: unknown;
        parentUuid?: unknown;
        type?: unknown;
        isSidechain?: unknown;
        isCompactSummary?: unknown;
      };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // torn line
      }
      if (!entry || typeof entry.uuid !== "string" || !entry.uuid) continue;
      // A re-written uuid keeps its first position and takes the latest
      // fields, like the Map the CLI builds.
      rows.set(entry.uuid, {
        parent: typeof entry.parentUuid === "string" && entry.parentUuid ? entry.parentUuid : null,
        type: typeof entry.type === "string" ? entry.type : "",
        sidechain: entry.isSidechain === true,
        compactSummary: entry.isCompactSummary === true,
        pos: rows.get(entry.uuid)?.pos ?? pos,
      });
    }
  } catch {
    return null;
  }
  let firstTurnPos = Infinity;
  for (const r of rows.values()) {
    if (!r.sidechain && (r.type === "user" || r.type === "assistant") && r.pos < firstTurnPos) {
      firstTurnPos = r.pos;
    }
  }
  return { rows, firstTurnPos };
}

/**
 * Whether the history the SDK loaded starts at a cut — the CLI's rule: the
 * chain's first row names a parent that isn't in the file. Walks up from
 * `firstLoadedUuid` (the first message `getSessionMessages` returned) through
 * rows the SDK's chain would also cross, to the chain's root, which must:
 *
 * - name a parent (a null parent is a real start: a fresh session, or a
 *   compact boundary, whose old chain is only a `logicalParentUuid`);
 * - name one missing from the file entirely (any row type counts as present);
 * - not be a sidechain row or an `isCompactSummary` prompt;
 * - come after the file's first main-chain user/assistant row, so the
 *   opening prompt (a fork's or a copied tail's) is never the one flagged.
 *
 * False whenever it can't tell: `firstLoadedUuid` not in the file (the SDK
 * read a different copy), a cycle, or a parent row of another type.
 */
export function hasMissingParentAbove(links: TranscriptLinks, firstLoadedUuid: string): boolean {
  let row = links.rows.get(firstLoadedUuid);
  if (!row) return false;
  const seen = new Set<string>([firstLoadedUuid]);
  while (row.parent) {
    const next = links.rows.get(row.parent);
    if (!next) break; // missing — `row` is the chain's root
    if (!CHAIN_TYPES.has(next.type) || seen.has(row.parent)) return false;
    seen.add(row.parent);
    row = next;
  }
  if (!row.parent || row.sidechain) return false;
  if (row.type === "user" && row.compactSummary) return false;
  return row.pos > links.firstTurnPos;
}

/** {@link readTranscriptLinks} + {@link hasMissingParentAbove}; false when unreadable. */
export async function transcriptHasMissingParent(
  file: string,
  firstLoadedUuid: string,
  projectsBase?: string,
): Promise<boolean> {
  const links = await readTranscriptLinks(file, projectsBase);
  return !!links && hasMissingParentAbove(links, firstLoadedUuid);
}

/**
 * The mode switch `Session` last recorded in the session's state bag (CC
 * 2.1.317, see `lib/shared/permission-mode-record.ts`), if any.
 */
export async function persistedPermissionMode(
  id: string,
  cwd: string,
): Promise<{ mode: string; at: number } | null> {
  const state = await getSessionState(cwd, id).catch(() => ({}) as Record<string, unknown>);
  return readPermissionModeRecord(state);
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
 *
 * CC 2.1.317 — for a session that isn't live, "last recorded" is the newer
 * of the transcript's stamp and the switch `Session` persisted (see
 * `pickRecordedPermissionMode`), so a switch with no prompt after it
 * survives a reap or restart.
 */
export async function resumePermissionMode(
  id: string,
  cwd: string,
  fallback: PermissionMode | undefined,
): Promise<PermissionMode | undefined> {
  const live = sessionManager.get(id);
  const was = live
    ? live.getPermissionMode()
    : pickRecordedPermissionMode(
        await lastRecordedPermissionModeAt(id, cwd),
        await persistedPermissionMode(id, cwd),
      );
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
    // CC 2.1.311 — a session whose SDK process died between turns is
    // restarted while a tab is attached (stream connect, pollers). Passive:
    // these callers get only the first attempt, and only once the process
    // had come up, so a poll can't use up the budget meant for the user's
    // next send or respawn a process that dies on boot. When it can't
    // restart, the dead instance is still returned so read-only routes keep
    // working and the input route reports the failure.
    if (existing.isDead()) {
      const restarted = await sessionManager.restartIfDead(id, { passive: true });
      return restarted.ok ? restarted.session : existing;
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
