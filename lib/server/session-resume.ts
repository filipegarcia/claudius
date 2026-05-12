import { sessionManager } from "./session-manager";
import { info as sessionFileInfo } from "./sessions-store";
import { listWorkspaces, type Workspace } from "./workspaces-store";
import type { Session } from "./session";

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
  if (existing) return existing;
  try {
    const fileInfo = await sessionFileInfo(id);
    if (!fileInfo?.cwd) return null;
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const originWs = all.find((w) => w.rootPath === fileInfo.cwd) ?? null;
    const defaults = originWs?.defaults ?? {};
    const session = await sessionManager.create({
      resume: id,
      cwd: fileInfo.cwd,
      model: defaults.model,
      permissionMode: defaults.permissionMode,
    });
    // Reconcile: an in-memory hit (idempotent resume) doesn't pick up a
    // freshly-changed workspace default — same fix as in POST /api/sessions.
    if (defaults.permissionMode && session.getPermissionMode() !== defaults.permissionMode) {
      await session.setPermissionMode(defaults.permissionMode);
    }
    return session;
  } catch {
    return null;
  }
}
