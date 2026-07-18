import type { DisplayBlock, DisplayMessage, TaskInfo, TaskStatus, ToolProgressInfo } from "./types";

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

/**
 * Liveness gate driven by the SDK's `background_tasks_changed` snapshot
 * (0.3.203). `liveIds` is the authoritative set of live background-task ids
 * from the latest snapshot, or `null` when none has been received yet.
 *
 * Returns false only for a task the rail still shows as `running` that the
 * snapshot no longer lists — i.e. a stranded row whose terminal
 * `task_notification` was dropped (the exact failure the rest of this module
 * works around). Everything else is live:
 *   - a `null` snapshot disables the gate (we never hide a task we have no
 *     authoritative word on — e.g. right after `system:init` reset it to null,
 *     or on a resumed session before the first snapshot);
 *   - non-`running` statuses (`pending`/provisional pre-start rows, or terminal
 *     rows) are never gated — a not-yet-started task is legitimately absent
 *     from the live set.
 *
 * Ordering vs the `task_*` edge stream is unspecified, so this is a
 * derivation-time filter that self-corrects on the next snapshot (a task's
 * start is itself a membership change, so the SDK re-emits a snapshot that
 * includes it); it must never be used to mutate the canonical `tasks` map.
 */
export function isBackgroundTaskLive(
  task: Pick<TaskInfo, "taskId" | "status">,
  liveIds: ReadonlySet<string> | null | undefined,
): boolean {
  if (task.status !== "running") return true;
  if (!liveIds) return true;
  return liveIds.has(task.taskId);
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
 * Whether a persisted snapshot task should trigger the synthesize-and-prepend
 * orphan recovery in `use-session`'s `task_snapshot` handler.
 *
 * Qualifies only when the task (a) carries a `toolUseId`, (b) is NOT running,
 * and (c) has no matching tool_use block already in the rendered `messages`.
 *
 * The running guard fixes the "agent started before my message" reattach bug.
 * On reattach to a LIVE session, the `task_snapshot` event can be handled
 * before the SSE replay has painted the running subagent's parent tool_use
 * block (the messages ref lags the `setMessages` from replay). The task then
 * looks orphaned, so recovery synthesizes a placeholder pill and PREPENDS it to
 * the top of the timeline — above the user's prompt — duplicating the real pill
 * the live stream paints a moment later. But a running task IS the current
 * turn: its parent tool_use is always inside the tail window and arrives via
 * the live stream, and SDK compaction (the only thing that orphans a task by
 * removing its parent) never touches the in-flight turn. So a running-yet-
 * unlinked task is always a transient race — skip recovery and let the live
 * event link the TaskBlock by `toolUseId`. Recovery still fires for genuinely
 * orphaned COMPLETED tasks (parent compacted away).
 */
export function shouldRecoverOrphanTask<
  T extends { toolUseId?: string | null; status?: TaskStatus | string },
>(task: T, messages: DisplayMessage[]): task is T & { toolUseId: string } {
  if (!task.toolUseId) return false;
  if (task.status === "running") return false;
  return !findToolUseBlock(task.toolUseId, messages);
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

/**
 * SDK 0.3.214 — find the live `subagent_retry` state (if any) for a Task's
 * INNER tool call, given the outer Task's own `toolUseId` and the flat
 * `session.toolProgress` map.
 *
 * `tool_progress.parent_tool_use_id` on a subagent's tool call points at the
 * outer Task/Agent tool_use — never at itself — so the retry state is never
 * keyed directly by `toolUseId`; it has to be found by scanning for an entry
 * whose `parentToolUseId` matches. Only meaningful while the task is still
 * running (a finished/failed/killed Task can't be mid-retry).
 */
export function findSubagentRetry(
  toolUseId: string,
  status: TaskStatus,
  progress: Record<string, ToolProgressInfo> | undefined,
): ToolProgressInfo["subagentRetry"] {
  if (status !== "running" || !progress) return undefined;
  for (const p of Object.values(progress)) {
    if (p.parentToolUseId === toolUseId && p.subagentRetry) return p.subagentRetry;
  }
  return undefined;
}
