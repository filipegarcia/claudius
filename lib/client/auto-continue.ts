/**
 * CC 2.1.234 — when `autoContinueAtUsageLimit` is on and a session hits the
 * usage limit, the panel shows "Continuing automatically at HH:MM" instead of
 * leaving the user with "nothing to click, you just wait". Pure helper for the
 * line text so the panel's branching is unit-testable; returns null when the
 * line shouldn't show (setting off, or the reset time is unknown).
 */
export function autoContinueNotice(
  autoContinue: boolean | undefined,
  resetClock: string | null,
): string | null {
  if (!autoContinue || !resetClock) return null;
  return `Continuing automatically at ${resetClock}`;
}
