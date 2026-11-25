import { nextFireMs } from "@/lib/shared/cron";
import { LOOP_RECURRING_MAX_AGE_MS, loopEndsAt, type SessionLoop } from "@/lib/shared/session-loops";

/**
 * CC 2.1.292 — "Fixed a background session's `/loop` silently stopping when
 * the session's process restarted, because its pending wakeup was lost."
 *
 * Claudius's analogue: the engine holds a `/loop` wake-up (or a session
 * cron) as a timer inside the SDK process, and the idle reaper in
 * `session-manager.ts` ends that process once a session has had no tab open
 * for the reap window — so a loop left running in the background silently
 * stopped. These predicates tell the reaper when a loop still needs the
 * process alive.
 *
 * `scheduledLoops` entries are never removed when they fire (a wake-up is
 * only superseded by the next one; a cron is only flagged `cancelled`), so
 * "has an entry" would pin a session forever. Only a loop that is still
 * going to fire counts.
 */

/**
 * How long after a tick's fire time the loop still counts as armed: the
 * tick's turn runs, and the model arms the next wake-up at its end. A fixed
 * window rather than `turnInFlight`, which only Claudius's own sends set —
 * a turn the engine starts for a wake-up never does.
 */
export const LOOP_TICK_GRACE_MS = 30 * 60 * 1000;

/**
 * Upper bound on how long an unwatched one-shot session cron keeps its
 * session (and SDK process) in memory while it waits for its fire. CC 2.1.330
 * — the engine's longest job life is now 30 days (was 7). A recurring cron is
 * bounded by its own end instead (`loopEndsAt`).
 */
export const LOOP_KEEPALIVE_MAX_MS = LOOP_RECURRING_MAX_AGE_MS;

/** True when `loop` will still fire, or its tick may still be running. */
export function isLoopArmed(loop: SessionLoop, now: number): boolean {
  if (loop.cancelled) return false;
  if (loop.kind === "wakeup") {
    // A `stop: true` call carries no delay — nothing is pending.
    if (loop.delaySeconds == null) return false;
    return loop.startedAt + loop.delaySeconds * 1000 + LOOP_TICK_GRACE_MS > now;
  }
  // CC 2.1.330 — "Changed recurring scheduled tasks and `/loop` to run up to
  // 30 days instead of 7 while their session keeps running … tasks made
  // before this release still end at 7 days". A recurring cron stays armed
  // until its own end (maxAgeMs, else 7 days) plus its last tick's grace.
  const endsAt = loopEndsAt(loop);
  if (endsAt !== null) return endsAt + LOOP_TICK_GRACE_MS > now;
  if (now - loop.startedAt > LOOP_KEEPALIVE_MAX_MS) return false;
  if (!loop.cron) return false;
  const firstFire = nextFireMs(loop.cron, new Date(loop.startedAt));
  return firstFire != null && firstFire + LOOP_TICK_GRACE_MS > now;
}

export function hasArmedLoop(loops: Iterable<SessionLoop>, now: number): boolean {
  for (const loop of loops) {
    if (isLoopArmed(loop, now)) return true;
  }
  return false;
}
