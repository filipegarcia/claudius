import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getWorkspace } from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/counts-by-session?workspace=<id>
 *
 * Per-session unread counts for a single workspace, keyed by session id. The
 * SessionTabs strip uses this to render a small badge on the tab whenever a
 * background session has accumulated permission requests / ask-user-question
 * forms / errors / idle pings.
 *
 * Defaults to the active-workspace cookie when `workspace` is omitted so the
 * common case (one workspace at a time) doesn't need a param. Unknown
 * workspace ids return 404 — matching `/api/notifications`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("workspace");

  let workspaceId = explicit;
  if (!workspaceId) {
    const active = await resolveActiveWorkspace().catch(() => null);
    workspaceId = active?.id ?? null;
  }
  if (!workspaceId) {
    return NextResponse.json({ counts: {} });
  }
  const ws = await getWorkspace(workspaceId).catch(() => null);
  if (!ws) return NextResponse.json({ error: "unknown workspace" }, { status: 404 });

  const counts = await notificationBus.countsBySession(workspaceId);
  return NextResponse.json({ counts });
}
