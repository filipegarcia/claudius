import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { PathInjectionError, assertAbsoluteUserPath } from "@/lib/server/safe-path";
import {
  listWorkspaceSessionIds,
  relocateWorkspaceSessions,
} from "@/lib/server/workspace-relocate";
import { getWorkspace, listWorkspaces, updateWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";

/**
 * Preview for the "move sessions to the new root?" prompt on the workspace
 * settings page: how many sessions live under the current root, how many of
 * them are mid-turn right now (those block the move), and which other
 * workspaces share the same root (their sessions would move too).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ids = await listWorkspaceSessionIds(ws.rootPath).catch(() => [] as string[]);
  const busy = sessionManager
    .sessionsByCwd(ws.rootPath)
    .filter((s) => s.getStatus() !== "idle").length;
  const sharedWith = (await listWorkspaces())
    .filter((w) => w.id !== ws.id && w.rootPath === ws.rootPath)
    .map((w) => w.name);
  return NextResponse.json({ rootPath: ws.rootPath, count: ids.length, busy, sharedWith });
}

/**
 * Re-root the workspace AND carry its sessions along: transcripts, sidecars,
 * chat assets and the per-workspace `.claudius.db` move from the old root's
 * project dir to the new one (see lib/server/workspace-relocate.ts). The root
 * update happens here too, server-side, so there's no window where sessions
 * sit under a root the workspace no longer points at.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  let to: string;
  try {
    const body = (await req.json()) as { to?: unknown };
    if (typeof body.to !== "string") {
      return NextResponse.json({ error: "missing target root" }, { status: 400 });
    }
    // Same barrier the workspace PATCH uses for `rootPath`.
    to = assertAbsoluteUserPath(body.to);
  } catch (err) {
    if (err instanceof PathInjectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  try {
    const stat = await fs.stat(to);
    if (!stat.isDirectory()) return NextResponse.json({ error: "rootPath not a directory" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "rootPath does not exist" }, { status: 400 });
  }
  if (to === ws.rootPath) {
    return NextResponse.json({ workspace: ws, moved: 0, failed: [] });
  }

  // A live Claude Code process appends to its transcript by path — moving
  // the file under it would split the conversation. Idle sessions are ended
  // (open tabs resume them from the new location on next use); sessions that
  // are mid-turn or waiting on a prompt block the move instead of being
  // killed.
  const live = sessionManager.sessionsByCwd(ws.rootPath);
  const busy = live.filter((s) => s.getStatus() !== "idle");
  if (busy.length > 0) {
    const n = busy.length;
    return NextResponse.json(
      {
        error:
          `${n} chat${n === 1 ? " is" : "s are"} still working in this workspace. ` +
          `Wait for ${n === 1 ? "it" : "them"} to finish (or stop ${n === 1 ? "it" : "them"}), then save again.`,
      },
      { status: 409 },
    );
  }
  for (const s of live) await sessionManager.remove(s.id).catch(() => {});

  let result;
  try {
    result = await relocateWorkspaceSessions(ws.rootPath, to);
  } catch (err) {
    return NextResponse.json(
      { error: `Moving sessions failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
  const updated = await updateWorkspace(id, { rootPath: to });
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ workspace: updated, ...result });
}
