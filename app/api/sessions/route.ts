import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getWorkspace, listWorkspaces, type Workspace } from "@/lib/server/workspaces-store";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import type { CreateSessionRequest } from "@/lib/shared/events";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: CreateSessionRequest = {};
  try {
    body = (await req.json()) as CreateSessionRequest;
  } catch {
    body = {};
  }
  // Default cwd resolution order:
  //   1. explicit body.cwd
  //   2. when resuming: the session's *original* cwd from its JSONL on disk
  //      (must come before the workspace fallback — otherwise the SDK looks
  //      in the wrong project dir, can't find the session, and silently
  //      starts a fresh conversation under a new id)
  //   3. active workspace from cookie / hint
  //   4. process.cwd() (legacy fallback, kept so headless callers still work)
  let cwd = body.cwd;
  let originWs: Workspace | null = null;
  if (!cwd && body.resume) {
    try {
      const info = await sessionFileInfo(body.resume);
      if (info?.cwd) cwd = info.cwd;
    } catch {
      // fall through to workspace resolution
    }
  }
  if (!cwd) {
    const ws = await resolveActiveWorkspace().catch(() => null);
    if (ws) {
      cwd = ws.rootPath;
      originWs = ws;
    }
  } else {
    // Explicit cwd — find the workspace whose rootPath matches so its
    // defaults still apply.
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    originWs = all.find((w) => w.rootPath === cwd) ?? null;
  }

  // Merge: workspace defaults *under* explicit body fields. Spec rule:
  //   effective = { ...workspace.defaults, ...request }
  const defaults = originWs?.defaults ?? {};
  const model = body.model ?? defaults.model;
  const permissionMode = body.permissionMode ?? defaults.permissionMode;

  const session = await sessionManager.create({
    cwd,
    model,
    permissionMode,
    resume: body.resume,
    resumeSessionAt: body.resumeSessionAt,
  });
  return NextResponse.json({
    id: session.id,
    cwd: session.cwd,
    model: session.model,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  let filter: ((cwd: string) => boolean) | null = null;
  if (workspaceId) {
    const ws = await getWorkspace(workspaceId).catch(() => null);
    if (ws) filter = (cwd) => cwd === ws.rootPath;
  }
  const list = sessionManager
    .list()
    .map((s) => ({ id: s.id, cwd: s.cwd, model: s.model, title: s.title ?? null }))
    .filter((s) => (filter ? filter(s.cwd) : true));
  return NextResponse.json(list);
}
