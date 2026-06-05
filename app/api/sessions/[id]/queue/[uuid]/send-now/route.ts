import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

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
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const dispatched = await session.sendQueuedNow(uuid);
  return NextResponse.json({ ok: true, dispatched });
}
