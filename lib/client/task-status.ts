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
 *
 * The `Workflow` tool is *always* backgrounded: it returns a "started, here's
 * the runId" ack in ~0s and its real completion arrives via `task_notification`
 * on the `local_workflow` task. It does NOT carry `run_in_background` in its
 * input, so without this name check the 0s ack would (depending on SSE
 * ordering) mis-seed/reconcile the still-running workflow task to "completed",
 * bouncing it out of "Tasks" into "Recent" until a later progress tick rescued
 * it — the exact "the running box took ages to appear" symptom.
 */
export function isBackgroundedToolUse(block: ToolUseBlock | null): boolean {
  if (!block) return false;
  if ((block.input as { run_in_background?: unknown }).run_in_background === true) return true;
  if (block.name === "Workflow") return true;
  return false;
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

/**
 * Provisional ("placeholder") task lifecycle.
 *
 * A backgrounded launcher (the Workflow tool) returns a "started, here's the
 * runId" ack in ~0s, but the SDK's `task_started` for the underlying task can
 * lag until the runtime spins up — a dead-zone where the work is alive but the
 * rail shows nothing. We seed a provisional row off the ack, keyed by
 * `tool_use_id` (its own `taskId === toolUseId`), and let the real lifecycle
 * events replace/clear it.
 *
 * Cleanup must be authoritative: `task_started` and `task_notification` both
 * carry `tool_use_id`, and the task-status module's whole reason for existing
 * is that these events aren't perfectly ordered/delivered. So every event that
 * can establish or settle the real task drops the matching provisional —
 * otherwise a notification-without-a-prior-started would strand a phantom
 * "running" row forever.
 */

/** True when a real (non-provisional) task already owns `toolUseId`. */
export function hasRealTaskForToolUse(
  tasks: Record<string, TaskInfo>,
  toolUseId: string,
): boolean {
  return Object.values(tasks).some((t) => t.toolUseId === toolUseId && !t.provisional);
}

/**
 * Insert a provisional placeholder keyed by its `toolUseId`. No-op (same ref)
 * when a real task already owns that tool_use_id, or a provisional is already
 * present — idempotent against SSE replay re-firing the launch ack.
 */
export function upsertProvisionalTask(
  tasks: Record<string, TaskInfo>,
  provisional: TaskInfo & { toolUseId: string },
): Record<string, TaskInfo> {
  const key = provisional.toolUseId;
  if (hasRealTaskForToolUse(tasks, key)) return tasks;
  if (tasks[key]?.provisional) return tasks;
  return { ...tasks, [key]: { ...provisional, taskId: key, provisional: true } };
}

/**
 * Drop the provisional placeholder for `toolUseId`, if any. Returns the carried
 * `startedAt` so the replacing real task can keep the ticking timer continuous.
 * Returns the same map ref when there's nothing to drop.
 */
export function dropProvisionalForToolUse(
  tasks: Record<string, TaskInfo>,
  toolUseId: string | undefined,
): { tasks: Record<string, TaskInfo>; carriedStartedAt?: number } {
  if (!toolUseId) return { tasks };
  const existing = tasks[toolUseId];
  if (!existing?.provisional) return { tasks };
  const next = { ...tasks };
  delete next[toolUseId];
  return { tasks: next, carriedStartedAt: existing.startedAt };
}

/**
 * The set of task ids the "Stop all" rail button fans `stop-task` out over.
 *
 * Drawn from the THREE disjoint stoppable sources the rail already partitions —
 * agentic tasks (`subagents`), process tasks (monitors etc., `runningProcessTasks`),
 * and live background shells (`runningBashes`) — and NOT from the broader
 * `attention` count (which also folds in tool calls / pending permission /
 * scheduled loops, none of which `stop-task` can cancel). For shells we include
 * only those whose `taskId` resolves through `taskByToolUseId`, mirroring the
 * per-item Stop visibility in BackgroundBashes (hidden when no task is known)
 * so the confirm count stays honest. Scheduled loops are intentionally excluded
 * — they cancel via the agent-prompt path, not `stop-task`.
 *
 * Returns a deduped Set so `.size` is the true number of distinct tasks that
 * would be stopped (drives button visibility, the aria/confirm count, and the
 * fan-out itself — all from one source of truth).
 */
export function collectStoppableTaskIds(
  subagents: readonly TaskInfo[],
  runningProcessTasks: readonly TaskInfo[],
  runningBashes: readonly { toolUseId: string }[],
  taskByToolUseId: ReadonlyMap<string, TaskInfo>,
): Set<string> {
  const ids = new Set<string>();
  for (const t of subagents) ids.add(t.taskId);
  for (const t of runningProcessTasks) ids.add(t.taskId);
  for (const b of runningBashes) {
    const id = taskByToolUseId.get(b.toolUseId)?.taskId;
    if (id) ids.add(id);
  }
  return ids;
}
