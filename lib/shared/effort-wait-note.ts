/**
 * CC 2.1.312 — "Improved the prompt's effort indicator: a change made mid-task
 * now says it may wait for your next message, and the note clears when it no
 * longer applies" (and "Fixed the spinner … naming a newly picked effort level
 * during a task before the model applied it").
 *
 * Claude Code's indicator reads `<level> · may wait for your next message`
 * while the effort the in-flight request was sent with differs from the
 * current pick. Claudius's effort pill switches to a new pick the moment it is
 * made, even mid-turn, so it needs the same caveat: the running request keeps
 * the level it was sent with. A later request in the same turn, or the next
 * message, picks up the new level.
 *
 * Claudius doesn't see the effort each request is sent with, so it tracks the
 * level in force when the change was made and drops the note when one of these
 * happens:
 *  - a new main-thread request starts (`message_start`), which picks up the
 *    new level;
 *  - the level resolves back to the one in force (a switch back, or an "auto"
 *    pick that lands on the same level);
 *  - the model takes no effort parameter (`applied === null`);
 *  - the turn ends.
 *
 * Pure reducer-style helpers so the decision table is unit-testable without
 * React. The state lives in `lib/client/use-session.ts`.
 */

import type { EffortFlagLevel, EffortTier } from "@/lib/shared/effort-flags";

/** Claude Code's wording for the note. */
export const EFFORT_WAIT_NOTE = "may wait for your next message";

export type EffortWaitState = {
  /**
   * The level the running request was sent with, captured when the first
   * mid-turn change was made. Kept across further changes in the same window,
   * so going back to it clears the note. `null` means no change is waiting.
   */
  inForce: EffortFlagLevel | null;
  /** Whether the note shows. */
  waits: boolean;
};

export const NO_EFFORT_WAIT: EffortWaitState = { inForce: null, waits: false };

/**
 * The user picked `picked` (via `/effort` or the picker). `shownBefore` is the
 * level the pill showed just before (applied level, else the pick). Off-turn
 * changes are never a wait: the next request is the next message anyway.
 */
export function effortPicked(
  state: EffortWaitState,
  opts: { pending: boolean; picked: EffortFlagLevel; shownBefore: EffortFlagLevel },
): EffortWaitState {
  if (!opts.pending) return NO_EFFORT_WAIT;
  const inForce = state.inForce ?? opts.shownBefore;
  return { inForce, waits: opts.picked !== inForce };
}

/**
 * The server reported the level the SDK will now send (`effort_applied`).
 * `null` means the model takes no effort parameter, so there's nothing to wait
 * for. A level equal to the one in force means the change is a no-op for the
 * running request.
 */
export function effortApplied(state: EffortWaitState, applied: EffortTier | null): EffortWaitState {
  if (state.inForce === null) return state;
  if (applied === null) return NO_EFFORT_WAIT;
  return applied === state.inForce ? NO_EFFORT_WAIT : { ...state, waits: true };
}

/**
 * The text for a `/effort <level>` confirmation toast. When the change is
 * made mid-turn and differs from the level the pill shows now, add Claude
 * Code's note.
 */
export function effortToastText(
  base: string,
  opts: { pending: boolean; picked: EffortFlagLevel; shown: EffortFlagLevel | null },
): string {
  if (!opts.pending || opts.shown === null || opts.picked === opts.shown) return base;
  return `${base} · ${EFFORT_WAIT_NOTE}`;
}
