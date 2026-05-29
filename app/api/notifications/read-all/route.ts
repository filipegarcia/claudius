import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { workspaceId?: string };

/**
 * POST /api/notifications/read-all
 *
 * Marks every unread row in the target workspace as read. Defaults to the
 * active workspace when `workspaceId` is omitted. Returns the number of
 * rows that flipped — same shape as /:id/read so the client can update
 * optimistically without a refetch.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace();
    workspaceId = active?.id;
  }
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = await getWorkspace(workspaceId);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });
  const changed = await notificationBus.markAllRead(workspaceId);
  return NextResponse.json({ ok: true, changed });
}
