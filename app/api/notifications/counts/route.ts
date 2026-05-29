import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/counts
 *
 * Cross-workspace unread state. Returns a `states` map keyed by workspace id;
 * each entry carries the monotonic `version`, the workspace total, and the
 * per-session unread map. Used at app boot to paint badges before the SSE
 * connection lands its first state event, and on visibility/online recovery
 * to repair drift.
 *
 * The version comes from the same per-workspace counter the SSE `state`
 * event uses, so the client's version gate works seamlessly across the
 * HTTP and SSE paths — a slower /counts response can never overwrite a
 * fresher SSE-delivered state.
 */
export async function GET() {
  const states = await notificationBus.getAllWorkspaceStates();
  return NextResponse.json({ states });
}
