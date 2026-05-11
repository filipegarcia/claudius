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
  // Return the unread count so the test can sanity-check synchronously.
  const counts = await notificationBus.countsAllWorkspaces();
  return NextResponse.json({ ok: true, counts });
}
