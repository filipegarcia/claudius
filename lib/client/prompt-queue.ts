/**
 * FIFO queues for interactive prompts the agent is blocked on (permission
 * requests, AskUserQuestion forms, MCP elicitations).
 *
 * Several can be pending at once — parallel background subagents each forward
 * their own permission prompt (SDK 0.3.186+). The client used to hold one slot
 * per kind, so a second request overwrote the first and the first tool call
 * waited forever with nothing on screen. Claude Code 2.1.286/2.1.287 settled
 * the UX: show the oldest first, with an "N of M" count.
 *
 * Pure helpers so the ordering/dedup rules are unit-testable apart from the
 * hook. Both return the input array unchanged (same reference) when there's
 * nothing to do, so `setState(prev => …)` doesn't re-render needlessly.
 */

type Keyed = { requestId: string };

/**
 * Add a prompt to the back of the queue. A prompt already queued (the server
 * re-emits every pending prompt on subscribe, and the `/pending-prompts`
 * fetch overlaps that) is updated in place so it keeps its position.
 */
export function enqueuePrompt<T extends Keyed>(queue: readonly T[], item: T): T[] {
  const idx = queue.findIndex((q) => q.requestId === item.requestId);
  if (idx === -1) return [...queue, item];
  if (queue[idx] === item) return queue as T[];
  const next = queue.slice();
  next[idx] = item;
  return next;
}

/** Remove a prompt (answered here, or settled elsewhere). */
export function dropPrompt<T extends Keyed>(queue: readonly T[], requestId: string): T[] {
  return queue.some((q) => q.requestId === requestId) ? queue.filter((q) => q.requestId !== requestId) : (queue as T[]);
}

/**
 * Merge the server's pending list (`/pending-prompts`, fetched after a
 * replay) into the local queue: append any prompt this tab is missing, in
 * server order (oldest first), and leave everything already queued alone.
 *
 * Deliberately a merge, not a replace. SSE and the fetch are separate
 * channels, so a prompt can reach this tab over SSE while the fetch is in
 * flight yet be missing from a response the server built a moment earlier —
 * replacing would drop it, which is the exact lost-prompt bug the queue
 * exists to fix. A local prompt that really did settle while the tab wasn't
 * listening costs one click: answering it gets a 404 and it's dropped.
 *
 * `gone` holds ids this tab answered or saw settle; the response may predate
 * that, so they are never re-added.
 */
export function mergeServerPrompts<T extends Keyed>(
  local: readonly T[],
  server: readonly T[],
  gone: ReadonlySet<string>,
): T[] {
  let next = local as T[];
  for (const s of server) {
    if (gone.has(s.requestId) || next.some((l) => l.requestId === s.requestId)) continue;
    next = [...next, s];
  }
  return next;
}
