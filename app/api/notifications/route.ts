import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications?workspace=<id>&before=<ts>&limit=50&unreadOnly=1
 *
 * Lists notifications for a workspace, newest first. Defaults to the active
 * workspace cookie when `workspace` is omitted, so the Notification Center
 * can hit this with no params.
 *
 * `unreadOnly=1` filters to unread rows at the SQL level. The drawer uses
 * this so older unread rows can't fall off the 50-row pagination window
 * when read rows are dense at the top (the "workspace says 4, drawer
 * shows 1" bug the rewrite is fixing).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("workspace");
  const limitParam = url.searchParams.get("limit");
  const beforeParam = url.searchParams.get("before");
  const unreadOnly = url.searchParams.get("unreadOnly") === "1";
  const limit = limitParam ? Math.max(1, Math.min(200, Number(limitParam) || 50)) : 50;
  const before = beforeParam ? Number(beforeParam) : undefined;

  let workspaceId = explicit;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace();
    workspaceId = active?.id ?? null;
  }
  if (!workspaceId) {
    return NextResponse.json({ items: [] });
  }
  // Validate the id resolves to a workspace so we don't open random DBs.
  const ws = await getWorkspace(workspaceId);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });

  const items = await notificationBus.list(workspaceId, {
    limit,
    ...(before ? { before } : {}),
    ...(unreadOnly ? { unreadOnly: true } : {}),
  });
  return NextResponse.json({ items });
}
