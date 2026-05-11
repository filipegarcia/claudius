import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { workspaceId?: string };

/**
 * POST /api/notifications/:id/read
 *
 * Marks a single notification as read. The body should carry the
 * `workspaceId` so we know which `.claudius.db` to open without scanning
 * every workspace; we fall back to the active workspace cookie if omitted
 * (covers the "drawer-driven" path where the workspace is already implied).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;
  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace();
    workspaceId = active?.id;
  }
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = await getWorkspace(workspaceId);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });
  const changed = await notificationBus.markRead(workspaceId, [id]);
  return NextResponse.json({ ok: true, changed });
}
