import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/counts
 *
 * Cross-workspace unread counts keyed by workspace id. Used at app boot to
 * paint the workspace-tile badges, and on SSE reconnect to repair drift.
 * The bus memoizes the aggregate for 1s so burst polling stays cheap.
 */
export async function GET() {
  const counts = await notificationBus.countsAllWorkspaces();
  return NextResponse.json({ counts });
}
