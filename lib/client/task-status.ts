import type { DisplayBlock, DisplayMessage, TaskInfo, TaskStatus } from "./types";

/**
 * Subagent (Task) status reconciliation.
 *
 * The SDK's terminal `task_notification` system event isn't reliably
 * delivered for parallel subagents (and can arrive under a `task_id` that
 * doesn't match the one `task_started` used), which leaves a Task pill — and
 * the background-tasks rail — stuck on "running" long after the agent has
 * finished. The authoritative "this subagent returned" signal is the
 * `tool_result` on the Task tool_use itself, which always arrives (the parent
 * agent can't continue without it). These helpers flip a task to a terminal
 * state off that result.
 *
 * Pure + framework-free so the reconciliation can be unit-tested without a
 * live SDK stream.
 */

type ToolUseBlock = Extract<DisplayBlock, { kind: "tool_use" }>;

const NON_TERMINAL: ReadonlySet<TaskStatus> = new Set(["running", "pending"]);

export function isNonTerminalTaskStatus(s: TaskStatus): boolean {
  return NON_TERMINAL.has(s);
}

/** Terminal status implied by a (foreground) Task tool_result. */
export function statusFromToolResult(isError: boolean | undefined): TaskStatus {
  return isError ? "failed" : "completed";
}

/** Locate a tool_use block by id across one or more message lists. */
export function findToolUseBlock(
  toolUseId: string,
  ...messageLists: DisplayMessage[][]
): ToolUseBlock | null {
  for (const list of messageLists) {
    for (const m of list) {
      for (const b of m.blocks) {
        if (b.kind === "tool_use" && b.id === toolUseId) return b;
      }
    }
  }
  return null;
}

/**
 * A Task launched with `run_in_background` gets an immediate "started in
 * background" tool_result that is NOT its completion — its real result rides
 * on a later `task_notification`. Such tasks must be excluded from
 * result-based completion.
 */
export function isBackgroundedToolUse(block: ToolUseBlock | null): boolean {
  return !!block && (block.input as { run_in_background?: unknown }).run_in_background === true;
}

/**
 * Flip any non-terminal, non-backgrounded task that owns `toolUseId` to the
 * terminal status implied by its tool_result. Returns the same map reference
 * when nothing changed so callers can skip a needless re-render.
 */
export function reconcileTasksOnToolResult(
  tasks: Record<string, TaskInfo>,
  toolUseId: string,
  isError: boolean | undefined,
  backgrounded: boolean,
): Record<string, TaskInfo> {
  if (backgrounded) return tasks;
  let changed = false;
  const next: Record<string, TaskInfo> = { ...tasks };
  for (const [id, t] of Object.entries(tasks)) {
    if (t.toolUseId !== toolUseId) continue;
    if (!isNonTerminalTaskStatus(t.status)) continue;
    if (t.isBackgrounded) continue;
    next[id] = { ...t, status: statusFromToolResult(isError) };
    changed = true;
  }
  return changed ? next : tasks;
}

/**
 * Initial status for a freshly-`task_started` task. Normally "running", but
 * when the Task's `tool_result` already landed (SSE ordering put the result
 * before task_started) we seed the terminal status so the pill never gets
 * stuck. `block` is the matching tool_use block, if any.
 */
export function seedTaskStatus(block: ToolUseBlock | null): TaskStatus {
  if (block?.result && !isBackgroundedToolUse(block)) {
    return statusFromToolResult(block.result.isError);
  }
  return "running";
}
