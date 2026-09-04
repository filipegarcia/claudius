import type { DisplayMessage, ToolHistoryEntry } from "./types";

/**
 * Turn-end reconciliation for in-flight UI markers.
 *
 * The activity rail and the "Claude streaming…" indicator are driven by
 * per-block "still running" flags that are cleared by their own terminal
 * events: a tool row clears on its `tool_result`, a "Thinking" row on
 * `message_stop`, an assistant bubble's `streaming` on `message_stop`. When a
 * turn ends abnormally — the user interrupts, the stream aborts, or the SDK
 * simply doesn't emit the terminal event for a parallel subagent's tool —
 * those close events never arrive and the markers stay "running" even though
 * the session is idle. These pure sweeps reconcile that state when a terminal
 * `result` / `turn_status: idle` signal lands.
 *
 * Genuine background work (background bashes, backgrounded subagents) tracks
 * its liveness separately (`backgroundBashes`, `task.isBackgrounded`), so
 * sweeping `toolHistory` here doesn't hide it — at worst a backgrounded
 * subagent's inner tool shows "done" briefly until its own task_notification
 * re-renders, an acceptable cosmetic blip vs. a permanently stuck rail.
 */

/**
 * Apply a live thinking-token estimate from `SDKThinkingTokensMessage` to the
 * most-recent open thinking row in `entries`.
 *
 * The SDK emits these during the redacted-thinking streaming phase; they
 * carry no `message_id`, so historically we could only target the latest
 * open thinking entry by heuristic (in practice at most one thinking block
 * is in flight at a time). SDK 0.3.260 adds `user_message_uuid` — the
 * client-submitted uuid of the user message that triggered the turn — to
 * every frame. When present, prefer an entry already stamped with a
 * matching `userMessageUuid` over the plain "most recent open" pick: this
 * guards the rare race where a stale trailing frame from a just-interrupted
 * turn arrives after a new send has already opened its own thinking row
 * (both rows are "open" for a brief window). Falls back to the old
 * recency-only heuristic when no row carries a matching (or any) stamp yet,
 * or when the frame carries no `userMessageUuid` (older CLI).
 *
 * Returns the same reference when nothing changed.
 */
export function applyThinkingTokensEstimate(
  entries: ToolHistoryEntry[],
  estimatedTokens: number,
  userMessageUuid?: string,
): ToolHistoryEntry[] {
  let idx = -1;
  if (userMessageUuid) {
    idx = entries.findLastIndex(
      (e) => e.kind === "thinking" && !e.done && e.userMessageUuid === userMessageUuid,
    );
  }
  if (idx === -1) {
    idx = entries.findLastIndex((e) => e.kind === "thinking" && !e.done);
  }
  if (idx === -1) return entries;
  const next = entries.slice();
  next[idx] = {
    ...next[idx],
    estimatedThinkingTokens: estimatedTokens,
    ...(userMessageUuid ? { userMessageUuid } : {}),
  };
  return next;
}

/** Mark every not-yet-`done` tool-history entry done. Returns the same ref when nothing changed. */
export function sweepToolHistoryDone(
  entries: ToolHistoryEntry[],
  now: number,
): ToolHistoryEntry[] {
  let changed = false;
  const next = entries.map((e) => {
    if (e.done) return e;
    changed = true;
    return { ...e, done: true, endedAt: e.endedAt ?? now };
  });
  return changed ? next : entries;
}

/** Clear the `streaming` flag on every message. Returns the same ref when nothing changed. */
export function clearStreaming(messages: DisplayMessage[]): DisplayMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.streaming) return m;
    changed = true;
    return { ...m, streaming: false };
  });
  return changed ? next : messages;
}
