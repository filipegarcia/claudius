/**
 * Backoff policy for rebuilding a permanently-dead session SSE stream.
 *
 * `EventSource` retries transient drops on its own and we leave it alone for
 * those. This covers the case the browser gives up on — readyState CLOSED,
 * which it reaches when a retry is answered with a non-2xx (a dev-server
 * rebuild, a 404 from `getOrResumeSession` inside the idle-reap window, a
 * proxy hiccup). The browser never retries after that, so the tab owns the
 * recovery.
 *
 * Pure + framework-free so the curve can be pinned down in a unit test
 * without standing up a React hook or a fake EventSource; `use-session.ts`
 * just feeds it a counter.
 */

/** Longest gap between attempts. */
export const STREAM_RECOVERY_MAX_DELAY_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt` (0-based, counting only
 * *consecutive* failures — a successful handshake resets the counter).
 *
 * Doubling from 1s and capped at 30s. The cap is the part that matters: the
 * common cause is a server that's back within seconds, so the early attempts
 * should be quick — but a laptop closed overnight must not wake up having
 * burned thousands of attempts against a machine that was never going to
 * answer. The ceiling is also why the visibility-change handler bypasses this
 * schedule entirely: a user who just came back shouldn't wait out a 30s gap
 * staring at a stale transcript.
 *
 * Negative or non-finite input is clamped to the first step rather than
 * producing a fractional/NaN delay that `setTimeout` would treat as 0 and
 * spin on.
 */
export function streamRecoveryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return 1_000;
  const step = Math.min(Math.floor(attempt), 5);
  return Math.min(STREAM_RECOVERY_MAX_DELAY_MS, 1_000 * 2 ** step);
}

/**
 * How long the stream may be down before a reconnect has to REBUILD the
 * transcript instead of merging the replay into what's on screen.
 *
 * The replay window is the last `tail=20` conversational turns. A reconnect
 * that lands inside that budget overlaps what the tab already has, and the
 * by-uuid dedup in the SSE reducer stitches it back together invisibly —
 * scroll position and loaded history survive, which is what you want for a
 * three-second network blip.
 *
 * Past the budget the window no longer reaches back to where the tab stopped
 * listening, so the merge silently produces a stale head, a fresh tail, and a
 * hole in between — with the "load older" sentinel stranded above the head
 * where it can never page into the gap. A hole is far worse than a scroll
 * jump: it looks like the work simply never happened.
 *
 * 15s is deliberately conservative against the turn budget. A tight tool
 * chain can emit a turn every second or two, so ~20 turns is reachable in
 * well under a minute; erring low costs an occasional unnecessary repaint,
 * erring high costs silent data loss.
 */
export const STREAM_REBUILD_AFTER_MS = 15_000;

/**
 * Whether a reconnect that was down for `downMs` must rebuild the transcript.
 *
 * `downMs <= 0` (no recorded outage — the first connect of a binding) merges,
 * since there's nothing on screen to hole-punch.
 */
export function shouldRebuildTranscript(downMs: number): boolean {
  if (!Number.isFinite(downMs)) return true;
  return downMs > STREAM_REBUILD_AFTER_MS;
}

/**
 * How long the stream must stay down before the "Reconnecting" badge appears.
 *
 * Without a debounce the badge fires on every `onerror`, including the ones
 * the browser fixes by itself within one retry cycle — a server restart, a
 * momentary network blip, a stream the server closed cleanly. That's a pill
 * flashing amber several times an hour for conditions the user can do
 * nothing about and that cost them nothing, which is how a warning gets
 * tuned out right before the one time it matters.
 *
 * 4s is one full `EventSource` retry cycle (Chromium defaults to 3s) plus
 * headroom, so the badge means something specific and worth reading: "this
 * outage already outlived a normal reconnect, so what you see below may be
 * behind." A genuinely-down server — the case where the socket cycles in
 * CONNECTING forever and never reaches CLOSED — crosses it immediately.
 */
export const STREAM_BADGE_AFTER_MS = 4_000;
