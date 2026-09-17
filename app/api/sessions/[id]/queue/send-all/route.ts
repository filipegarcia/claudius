import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * "Send all now" — the Ctrl+Enter send-now key from the QueueIndicator strip
 * (Claude Code parity, 2.1.275: "a send-now key ... that interrupts the
 * current turn and sends all queued messages at once"). Interrupts any
 * in-flight turn, then dispatches every currently queued message via the
 * same per-item `Session.sendQueuedNow` primitive the single-item "Send
 * now" button already uses — just looped over a snapshot of the queue
 * taken after the interrupt.
 *
 * No new session-state mutation logic: this route is a thin orchestration
 * of three existing, already-tested `Session` methods (`interrupt`,
 * `getQueueSnapshot`, `sendQueuedNow`), so it inherits their idempotency —
 * a uuid that's already gone (raced by another tab, or by `flushQueueIfIdle`)
 * is silently skipped rather than erroring.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  await session.interrupt();
  const snapshot = await session.getQueueSnapshot();
  const dispatched: string[] = [];
  // Iterate the snapshot in FIFO order and dispatch each in turn. Node is
  // single-threaded and nothing else in this process writes to
  // `Session.inputQueue`, so even though `sendQueuedNow`'s internal
  // `await`s yield the event loop between iterations, the `push()` calls
  // it makes land in the same order this loop issues them — the SDK may
  // start consuming item 0 before item 1 is even popped from the DB, but
  // it can never observe item 1 before item 0. This is the same "asap"
  // sequential-turn model the single-item "Send now" override already
  // documents (see `Session.sendQueuedNow`'s docstring): each dispatched
  // message becomes its own turn, run back-to-back, not one merged turn.
  for (const item of snapshot) {
    const ok = await session.sendQueuedNow(item.uuid);
    if (ok) dispatched.push(item.uuid);
  }
  return NextResponse.json({ ok: true, dispatched });
}
