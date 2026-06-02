import type { Message } from "@/lib/shared/community";

/**
 * Merge a server-side `replay` payload into the client's current message
 * buffer for a room.
 *
 * Why a merge instead of a blind replace?
 *
 *   1. Race against `loadOlder`: a backfill HTTP fetch the client kicked
 *      off can resolve *before* the SSE handshake delivers the initial
 *      replay frame. A blind replace would clobber whatever the
 *      backfill produced — including the case where the replay is empty
 *      (older chat-server deployments).
 *
 *   2. EventSource auto-reconnect: when the SSE socket drops and
 *      reconnects, the server re-sends `replay`. Any messages that
 *      arrived between the disconnect and the new replay (via `message`
 *      events that the new connection won't repeat) would be lost on a
 *      blind replace.
 *
 * Rules:
 *
 *   - If `prev` is empty, return `incoming` as-is (no merge needed).
 *   - Otherwise, build a map keyed by message id, server-wins for
 *     overlapping rows (so a `message_deleted` flip that landed in
 *     `prev` is overridden by the authoritative server view), and
 *     preserve any `prev`-only rows (the backfill / live edge cases
 *     above).
 *   - Return oldest-first, sorted by `createdAt` with `id` as the
 *     tiebreaker so the sort is stable across calls.
 *
 * Pure + framework-free so the merge can be unit-tested in isolation;
 * the React hook just calls this with the current state and the event
 * payload.
 */
export function mergeReplayMessages(
  prev: Message[],
  incoming: Message[],
): Message[] {
  if (prev.length === 0) return incoming;
  const byId = new Map<string, Message>();
  // Server-wins: insert the incoming rows first, then fill in any
  // prev-only rows that the server didn't repeat.
  for (const m of incoming) byId.set(m.id, m);
  for (const m of prev) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    // Same timestamp: tie-break by id so the sort is deterministic.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
