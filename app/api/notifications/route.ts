import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications?workspace=<id|all>&before=<ts>&limit=50&unreadOnly=1
 *
 * Lists notifications for a workspace, newest first. Defaults to the active
 * workspace cookie when `workspace` is omitted, so the Notification Center
 * can hit this with no params.
 *
 * `workspace=all` returns rows from every workspace, merged in created_at
 * DESC order. Used by the drawer so a notification fired in a workspace
 * the user isn't currently looking at is still visible — without this, the
 * favicon could count `(2)` while the active-workspace drawer said
 * "You're all caught up".
 *
 * `unreadOnly=1` filters to unread rows at the SQL level. The drawer uses
 * this so older unread rows can't fall off the 50-row pagination window
 * when read rows are dense at the top.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("workspace");
  const limitParam = url.searchParams.get("limit");
  const beforeParam = url.searchParams.get("before");
  const unreadOnly = url.searchParams.get("unreadOnly") === "1";
  const limit = limitParam ? Math.max(1, Math.min(200, Number(limitParam) || 50)) : 50;
  const before = beforeParam ? Number(beforeParam) : undefined;

  // Cross-workspace mode: aggregate from every workspace's DB. `before` is
  // intentionally NOT plumbed through here — cross-workspace pagination
  // would need a more careful cursor than a single `created_at` value, and
  // the drawer doesn't use pagination today. Add it when there's a caller.
  if (explicit === "all") {
    const items = await notificationBus.listAcrossWorkspaces({
      limit,
      ...(unreadOnly ? { unreadOnly: true } : {}),
    });
    return NextResponse.json({ items });
  }

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
