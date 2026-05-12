import { NextResponse } from "next/server";
import { notificationBus } from "@/lib/server/notification-bus";
import type { ServerEvent } from "@/lib/shared/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dev-only: synchronously call `notificationBus.recordSessionEvent` for a
 * synthesized event. Used by the e2e to assert the bus → DB → SSE → UI chain
 * end-to-end without depending on a live SDK turn.
 *
 * Body: { cwd: string; sessionId: string; event: ServerEvent }
 *
 * Gated by NODE_ENV !== 'production' so production builds 404 the route.
 */
type Body = {
  cwd?: string;
  sessionId?: string;
  event?: ServerEvent;
};

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only endpoint" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.cwd || !body.sessionId || !body.event) {
    return NextResponse.json(
      { error: "cwd, sessionId, event required" },
      { status: 400 },
    );
  }
  await notificationBus.recordSessionEvent(body.cwd, body.sessionId, body.event);
  // Return the workspace totals so the e2e can sanity-check synchronously.
  // We strip down to just `{[workspaceId]: totalUnread}` so the test surface
  // matches the prior return shape — internal state-shape changes don't
  // ripple into the fixture.
  const states = await notificationBus.getAllWorkspaceStates();
  const counts: Record<string, number> = {};
  for (const [id, s] of Object.entries(states)) counts[id] = s.totalUnread;
  return NextResponse.json({ ok: true, counts });
}
