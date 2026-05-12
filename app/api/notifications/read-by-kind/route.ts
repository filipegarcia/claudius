import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import {
  ALL_NOTIFICATION_KINDS,
  type NotificationKind,
} from "@/lib/shared/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { workspaceId?: string; kind?: string };

/**
 * POST /api/notifications/read-by-kind
 *
 * Marks every unread row of one kind in a workspace as read. Fired by the
 * workspace-settings page when the user unchecks a kind from the "Trigger
 * on" list: once they've said "stop notifying me about X", the backlog of
 * X rows should clear so the badge accurately reflects the new policy.
 *
 * Validates the kind against the known set so a malformed payload can't
 * craft an arbitrary `WHERE kind = ?` parameter.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const kind = body.kind?.trim();
  if (!kind) {
    return NextResponse.json({ error: "kind required" }, { status: 400 });
  }
  if (!ALL_NOTIFICATION_KINDS.includes(kind as NotificationKind)) {
    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  }

  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace();
    workspaceId = active?.id;
  }
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = await getWorkspace(workspaceId);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });

  const changed = await notificationBus.markReadByKind(
    workspaceId,
    kind as NotificationKind,
  );
  return NextResponse.json({ ok: true, changed });
}
