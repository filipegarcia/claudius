import type { SystemEntry } from "./types";

/**
 * Append a transient system pill (`init` / `status`), collapsing a run of
 * identical pills into ONE entry carrying a `×N` count instead of stacking
 * dozens. During an API-retry / opus-overload storm the SDK re-emits
 * `system/init` ("Session ready") and `system/status` ("Status: requesting")
 * many times in a row — each a genuinely distinct event with its own uuid, so
 * a uuid-based dedupe would collapse nothing. Keying the collapse on
 * `kind + label + afterMessageUuid` folds the burst (all sharing one anchor,
 * because a thrashing session emits no assistant output to advance the anchor)
 * into a single counted pill, while a genuine *later* re-init — e.g. the
 * `system/init` the SDK emits after `/compact` — carries a newer anchor and
 * correctly gets its own pill.
 *
 * Because the burst coalesces in place, the entry array stays small (the
 * `findIndex` scan never grows with the storm), and the `×N` badge preserves
 * the signal that the session actually thrashed rather than silently hiding it.
 *
 * Note: the count is keyed on content, not uuid, so an SSE reconnect that
 * replays already-delivered events can inflate `count` beyond the true number
 * of emissions. That over-count is bounded by the server's small replay window
 * and is a deliberate trade — a slightly-high number is far better than the
 * dozens of stacked pills this replaces.
 */
export function appendCoalescedSystemEntry(
  prev: SystemEntry[],
  incoming: SystemEntry,
): SystemEntry[] {
  const idx = prev.findIndex(
    (e) =>
      e.kind === incoming.kind &&
      e.label === incoming.label &&
      e.afterMessageUuid === incoming.afterMessageUuid,
  );
  if (idx === -1) return [...prev, incoming];
  const next = prev.slice();
  next[idx] = { ...next[idx], count: (next[idx].count ?? 1) + 1 };
  return next;
}
