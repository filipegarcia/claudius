import { NextResponse } from "next/server";
import { deadSessionResponse, sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Per-message "Send now" override on the QueueIndicator strip. Atomically
 * pops a specific queued message and pushes it into the SDK input pipe via
 * `Session.sendQueuedNow` — same effect as if the user had sent the message
 * with the global queue mode set to "asap".
 *
 * Idempotent: a second call with the same uuid (e.g. double-click on the
 * Send-now button, or two tabs racing) returns `{ ok: true, dispatched: false }`
 * because `popByUuid` returns null when the row is already gone. The caller
 * should treat both outcomes as success — the message is already on its way.
 *
 * Returns 404 only if the session itself doesn't exist; an unknown uuid for
 * a known session is the noop case above, not an error.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; uuid: string }> },
) {
  const { id, uuid } = await ctx.params;
  // CC 2.1.311 — a session whose SDK process died between turns would pop
  // the row and drop it while we answered `ok`. Restart it first (or join a
  // rebuild already under way); the rebuilt session drains the persisted
  // queue on start, so a row it already sent reads as "already on its way".
  const live = await sessionManager.restartIfDead(id);
  if (!live.ok) {
    const { error, status } = deadSessionResponse(live);
    return NextResponse.json({ error }, { status });
  }
  const session = live.session;
  const dispatched = await session.sendQueuedNow(uuid);
  return NextResponse.json({ ok: true, dispatched });
}
