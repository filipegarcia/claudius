import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * "Send all now" — the Ctrl+Enter send-now key from the QueueIndicator strip.
 *
 * Claude Code parity: 2.1.275 added the key ("interrupts the current turn and
 * sends all queued messages at once"); 2.1.281 changed it to "move running
 * tools to the background instead of cancelling the turn". SDK 0.3.286 makes
 * that reachable from a host: a user message sent with `priority: "now"` (plus
 * `origin: { kind: "human" }` — see `Session.sendInput`) joins the running
 * turn, and the CLI backgrounds any in-flight shell command, subagent or MCP
 * call so the model reads the message right away. So this route no longer
 * calls `session.interrupt()`: nothing the agent was doing is lost.
 *
 * Dispatches every queued message (FIFO) via `Session.sendQueuedNow`, which
 * is idempotent — a uuid already gone (raced by another tab, or by
 * `flushQueueIfIdle`) is silently skipped.
 *
 * Slash commands can't join a running turn; they always run as their own
 * turn. To keep queue order intact, the first queued slash command ends the
 * "join now" run: it and everything after it are sent without priority, so
 * they run back-to-back after the current turn, in order (the CLI's own
 * command queue is FIFO).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const snapshot = await session.getQueueSnapshot();
  const dispatched: string[] = [];
  // Node is single-threaded and nothing else in this process writes to
  // `Session.inputQueue`, so although `sendQueuedNow` awaits between
  // iterations, its `push()` calls land in the order this loop issues them.
  let joinRunningTurn = true;
  for (const item of snapshot) {
    if (item.slash) joinRunningTurn = false;
    const ok = await session.sendQueuedNow(
      item.uuid,
      joinRunningTurn ? { priority: "now" } : undefined,
    );
    if (ok) dispatched.push(item.uuid);
  }
  return NextResponse.json({ ok: true, dispatched });
}
