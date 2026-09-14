/**
 * Sub-label swap for a turn that's been running a long time without
 * producing visible output — the browser analog of Claude Code's terminal
 * spinner status text.
 *
 * Claude Code 2.1.271: "Improved the spinner status during long thinking:
 * it now reads 'deep in thought' after 45s." Claudius's `StatusLine`
 * already owns the turn's status label ("Working") and a live elapsed-time
 * ticker (`turnElapsedSec`, from `useElapsedSeconds`) — this just swaps the
 * label text once that ticker crosses the threshold, extending the
 * existing status-line affordance rather than adding a new one.
 *
 * Scoped conservatively to time-on-turn only, not "thinking specifically, as
 * opposed to running a tool". Claudius's Activity rail *does* track tool
 * calls per session, so the signal to distinguish those two sub-phases
 * exists elsewhere in the app — it just isn't threaded into `StatusLine`'s
 * props today, and doing so is a larger change than this label swap. See
 * the 2.1.271 run-notes "Risks" section for the maximal shape this was
 * weighed against.
 */

/** Seconds a turn must run continuously before the label reads "Deep in thought". Mirrors upstream's 45s. */
export const DEEP_IN_THOUGHT_THRESHOLD_SEC = 45;

/**
 * The label `StatusLine` shows while `status === "working"`. `turnElapsedSec`
 * is `null`/`undefined` before the ticker has a `turnStartedAt` to measure
 * from — treated the same as "not yet 45s in".
 */
export function workingStatusLabel(turnElapsedSec: number | null | undefined): string {
  if (typeof turnElapsedSec === "number" && turnElapsedSec >= DEEP_IN_THOUGHT_THRESHOLD_SEC) {
    return "Deep in thought";
  }
  return "Working";
}
