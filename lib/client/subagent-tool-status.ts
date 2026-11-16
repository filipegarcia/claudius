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

/** Why a result-less inner tool call will never finish. */
export type SettledToolReason = "stopped" | "failed" | "finished";

/**
 * The reason an inner tool call with no result is settled, given the owning
 * subagent's status, or `null` while the subagent can still deliver a result
 * (running / pending / paused, or no status known yet).
 */
export function settledToolReason(parentStatus: TaskStatus | undefined): SettledToolReason | null {
  switch (parentStatus) {
    case "stopped":
    case "killed":
      return "stopped";
    case "failed":
      return "failed";
    case "completed":
      return "finished";
    default:
      return null;
  }
}

/** The row's visible label. */
export function settledToolLabel(reason: SettledToolReason): string {
  if (reason === "stopped") return "Not run · stopped";
  if (reason === "failed") return "Not run · agent failed";
  return "Not run";
}

/** Hover text explaining the label. */
export function settledToolTitle(reason: SettledToolReason): string {
  if (reason === "stopped") return "Not run — the agent was stopped before this tool call finished";
  if (reason === "failed") return "Not run — the agent failed before this tool call finished";
  return "Not run — the agent finished without a result for this tool call";
}
