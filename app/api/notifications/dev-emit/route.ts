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
  /**
   * Forwarded to the bus as `hasSubscribers`. Lets the e2e test simulate a
   * backgrounded session (the user has switched to another in-app tab, so
   * the previous session's SSE has 0 subscribers). When omitted, the bus
   * sees `undefined` and treats it as "caller didn't tell us" → notify.
   */
  hasSubscribers?: boolean;
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
  // [dbg-notif] CI-only diagnostic — log incoming cwd/sessionId so we can
  // correlate against `lookupWorkspace MISS` log lines from the bus when
  // tests fail. Remove once the cwd→workspaceId mismatch is fixed.
  console.log(
    "[dbg-notif] dev-emit incoming",
    JSON.stringify({
      cwd: body.cwd,
      sessionId: body.sessionId,
      eventType: body.event?.type,
      hasSubscribers: body.hasSubscribers,
    }),
  );
  await notificationBus.recordSessionEvent(body.cwd, body.sessionId, body.event, {
    ...(typeof body.hasSubscribers === "boolean"
      ? { hasSubscribers: body.hasSubscribers }
      : {}),
  });
  // Return the workspace totals so the e2e can sanity-check synchronously.
  // We strip down to just `{[workspaceId]: totalUnread}` so the test surface
  // matches the prior return shape — internal state-shape changes don't
  // ripple into the fixture.
  const states = await notificationBus.getAllWorkspaceStates();
  const counts: Record<string, number> = {};
  for (const [id, s] of Object.entries(states)) counts[id] = s.totalUnread;
  // [dbg-notif] CI-only diagnostic — log the post-record counts so we can
  // tell server-state (bus + DB) failures from client-state (SSE + React)
  // failures. If counts is {wks_X: N} matching what the test expects but
  // the badge still doesn't render, the bug is in the SSE→client path.
  console.log("[dbg-notif] dev-emit response counts", JSON.stringify(counts));
  return NextResponse.json({ ok: true, counts });
}
