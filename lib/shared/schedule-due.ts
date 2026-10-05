/**
 * CC 2.1.286 (H11) — a scheduled job whose `nextRunAt` is in the past is
 * overdue (the runner hasn't caught up yet). The schedule page printed that
 * stale past timestamp verbatim; it should read "Due" instead, matching Claude
 * Code's "Due when late" treatment.
 *
 * Pure so the comparison is unit-testable.
 */

/** True when `nextRunAt` (epoch ms) is present and at/before `now` — i.e. overdue. */
export function isScheduleDue(nextRunAt: number | null | undefined, now: number): boolean {
  return typeof nextRunAt === "number" && Number.isFinite(nextRunAt) && nextRunAt <= now;
}
