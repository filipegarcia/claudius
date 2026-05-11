import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { workspaceId?: string; sessionId?: string };

/**
 * POST /api/notifications/read-by-session
 *
 * Marks every unread row tied to a single session as read. The chat page
 * fires this when the user picks a tab so the per-session badge and the
 * workspace bell-tile total both clear in one shot. Defaults to the active
 * workspace when `workspaceId` is omitted. Returns the number of rows that
 * flipped — same shape as /read-all so the client can update optimistically.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace();
    workspaceId = active?.id;
  }
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = await getWorkspace(workspaceId);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });

  const changed = await notificationBus.markReadBySession(workspaceId, sessionId);
  return NextResponse.json({ ok: true, changed });
}
