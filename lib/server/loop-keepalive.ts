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

/** How long after a wake-up's fire time its turn may still be running. */
export const LOOP_TICK_GRACE_MS = 60 * 60 * 1000;

/**
 * Upper bound on how long an unwatched recurring session cron keeps its
 * session (and SDK process) in memory.
 */
export const LOOP_KEEPALIVE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `loop` will still fire (or, mid-tick, is still running). */
export function isLoopArmed(loop: SessionLoop, now: number, turnInFlight: boolean): boolean {
  if (loop.cancelled) return false;
  if (loop.kind === "wakeup") {
    // A `stop: true` call carries no delay — nothing is pending.
    if (loop.delaySeconds == null) return false;
    const fireAt = loop.startedAt + loop.delaySeconds * 1000;
    if (fireAt > now) return true;
    // The tick fired and its turn is still going; the model arms the next
    // wake-up at the end of that turn.
    return turnInFlight && now - fireAt < LOOP_TICK_GRACE_MS;
  }
  if (now - loop.startedAt > LOOP_KEEPALIVE_MAX_MS) return false;
  if (loop.recurring) return true;
  if (!loop.cron) return false;
  const firstFire = nextFireMs(loop.cron, new Date(loop.startedAt));
  return firstFire != null && (firstFire > now || turnInFlight);
}

export function hasArmedLoop(loops: Iterable<SessionLoop>, now: number, turnInFlight: boolean): boolean {
  for (const loop of loops) {
    if (isLoopArmed(loop, now, turnInFlight)) return true;
  }
  return false;
}
