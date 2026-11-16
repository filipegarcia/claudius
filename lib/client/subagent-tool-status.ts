import type { TaskStatus } from "./types";

/**
 * CC 2.1.326 parity — "Fixed stopped and failed agents looking like running
 * ones in the agent rows under the prompt, or showing "Done" when run in
 * parallel, and a stopped agent's last command still showing "Running…"".
 *
 * A subagent that is stopped, killed or fails mid-call never sends a
 * tool_result for its last tool_use, so that inner row (a `ToolCall` in the
 * TaskBlock trail) used to read as running forever: pulsing dot plus a live
 * elapsed timer. Once the owning task has settled, a result-less inner call
 * can no longer complete, so it renders as "Not run" with the reason.
 *
 * Pure + framework-free so the decision is unit-testable.
 */

/**
 * Why a result-less inner tool call will never finish. A *completed* agent is
 * deliberately not here: it finished normally, so a missing result there is
 * more likely a gap in what Claudius captured than a call that didn't run,
 * and "Not run" would be a claim we can't back.
 */
export type SettledToolReason = "stopped" | "failed";

/**
 * The reason an inner tool call with no result is settled, given the owning
 * subagent's status, or `null` while the subagent can still deliver a result
 * (running / pending / paused, or no status known yet), and for a
 * completed agent (see `SettledToolReason`).
 */
export function settledToolReason(parentStatus: TaskStatus | undefined): SettledToolReason | null {
  switch (parentStatus) {
    case "stopped":
    case "killed":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** The row's visible label. */
export function settledToolLabel(reason: SettledToolReason): string {
  return reason === "stopped" ? "Not run · stopped" : "Not run · agent failed";
}

/** Hover text explaining the label. */
export function settledToolTitle(reason: SettledToolReason): string {
  return reason === "stopped"
    ? "Not run — the agent was stopped before this tool call finished"
    : "Not run — the agent failed before this tool call finished";
}
