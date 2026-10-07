import { nextFireMs } from "@/lib/shared/cron";
import type { SessionLoop } from "@/lib/shared/session-loops";

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
 * Upper bound on how long an unwatched recurring session cron keeps its
 * session (and SDK process) in memory.
 */
export const LOOP_KEEPALIVE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `loop` will still fire, or its tick may still be running. */
export function isLoopArmed(loop: SessionLoop, now: number): boolean {
  if (loop.cancelled) return false;
  if (loop.kind === "wakeup") {
    // A `stop: true` call carries no delay — nothing is pending.
    if (loop.delaySeconds == null) return false;
    return loop.startedAt + loop.delaySeconds * 1000 + LOOP_TICK_GRACE_MS > now;
  }
  if (now - loop.startedAt > LOOP_KEEPALIVE_MAX_MS) return false;
  if (loop.recurring) return true;
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
