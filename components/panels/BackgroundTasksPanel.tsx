"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bot, Brain, Check, CircleStop, Eraser, Loader2, Plus, Terminal, Wrench } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentTodo,
  BackgroundBash,
  PlanRateLimits,
  RecentEdit,
  ScheduledLoop,
  SessionUsage,
  TaskInfo,
  ToolHistoryEntry,
  ToolProgressInfo,
} from "@/lib/client/types";
import type { PermissionRequestEvent } from "@/lib/shared/events";
import { collectStoppableTaskIds } from "@/lib/client/task-status";
import { isStaleWakeup } from "@/lib/shared/session-loops";
import { CostOverlay } from "@/components/overlays/CostOverlay";
import { NotificationsDrawer } from "@/components/nav/NotificationsDrawer";
import { CollapsibleSection } from "./widgets/CollapsibleSection";
import { SessionCard } from "./widgets/SessionCard";
import { ContextBar } from "./widgets/ContextBar";
import { TokenMeter } from "./widgets/TokenMeter";
import { PermissionPending } from "./widgets/PermissionPending";
import { TodoList } from "./widgets/TodoList";
import { AddTodosForm } from "./widgets/AddTodosForm";
import { BackgroundBashes } from "./widgets/BackgroundBashes";
import { ScheduledLoops } from "./widgets/ScheduledLoops";
import { RecentEdits } from "./widgets/RecentEdits";
import { cn } from "@/lib/utils/cn";

type Props = {
  progress: Record<string, ToolProgressInfo>;
  tasks?: Record<string, TaskInfo>;
  sessionId: string | null;
  model: string | null;
  /** Current reasoning effort, surfaced on the SessionCard as a pill. */
  effort: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  permissionMode: PermissionMode;
  cwd: string | null;
  usage: SessionUsage | null;
  /** Plan-level rate-limit utilization from the experimental SDK usage API. */
  planUsage?: PlanRateLimits | null;
  /** Fallback turn count from the transcript when usage is null (resumed sessions). */
  historicalTurnCount?: number;
  /** False while the session is still binding — combined with `pending`,
   *  drives the spinner in the Activity header. */
  ready?: boolean;
  pending: boolean;
  pendingPermission: PermissionRequestEvent | null;
  latestTodos: AgentTodo[];
  recentEdits: RecentEdit[];
  backgroundBashes: Record<string, BackgroundBash>;
  /**
   * Loops/wake-ups armed via CronCreate / ScheduleWakeup in this session.
   * Always populated (may be empty) — rendered when at least one active
   * entry exists. Cancellation happens through `onCancelScheduledLoop`,
   * which composes a user-side prompt asking the agent to call CronDelete.
   */
  scheduledLoops: Record<string, ScheduledLoop>;
  toolHistory: ToolHistoryEntry[];
  /** Open the live-tail viewer for this bash. */
  onOpenBash?: (b: BackgroundBash) => void;
  /**
   * Open the full context-usage overlay. When provided, the compact
   * `ContextBar` summary becomes a clickable affordance. Optional — read-only
   * embeddings (e.g. the dev activity pages) leave it off.
   */
  onOpenContext?: () => void;
  /**
   * Ask the agent to cancel a scheduled loop. The handler should compose a
   * "Please cancel cron <id>" prompt and pipe it through useSession.send.
   * Omitting this hides the per-entry Cancel button.
   */
  onCancelScheduledLoop?: (loop: ScheduledLoop) => Promise<void> | void;
  /**
   * Ask the agent to append items to its TodoWrite list. The handler
   * should compose a prompt and pipe it through useSession.send (which
   * queues if a turn is in flight). Omitting this hides the `+` button.
   */
  onAddTodos?: (texts: string[]) => Promise<void> | void;
  /**
   * Durably clear the agent's TodoWrite snapshot — the rail counterpart
   * to the chat-level banner's Clear button. Hits the server endpoint so
   * the cleared state survives reload and server restart. Omitting hides
   * the eraser affordance.
   */
  onClearTodos?: () => Promise<void> | void;
  /**
   * Per-item mutation hook for the rail's `TodoList`. Wired through to
   * `useSession.updateTodoItem`. When provided, each rail row's status
   * icon becomes clickable (toggle complete ↔ pending) and a × on hover
   * deletes the item. The change is durable — persisted as a
   * `manualTodoOverrides` entry server-side so it survives reload. Omit
   * to render the rail list read-only.
   */
  onUpdateTodoItem?: (
    itemId: string,
    action: "complete" | "reopen" | "in_progress" | "delete",
  ) => void;
  /**
   * Switch the active model (the SDK's `setModel` control). Wired through
   * to `SessionCard` so the rail can offer a CLI-style `/model` picker.
   */
  onChangeModel?: (modelValue: string) => Promise<void> | void;
  /** Set reasoning effort. Same plumbing rationale as `onChangeModel`. */
  onChangeEffort?: (
    level: "low" | "medium" | "high" | "xhigh" | "max" | "auto",
  ) => Promise<void> | void;
  /** Whether ultracode (Dynamic Workflows) is on — shown as a SessionCard badge. */
  ultracode?: boolean;
  /** Toggle ultracode (Dynamic Workflows). Same plumbing rationale as `onChangeEffort`. */
  onChangeUltracode?: (enabled: boolean) => Promise<void> | void;
  /** Whether fast mode is on — shown as a SessionCard badge. */
  fastMode?: boolean;
  /** Toggle fast mode. Same plumbing rationale as `onChangeUltracode`. */
  onChangeFast?: (enabled: boolean) => Promise<void> | void;
  /** Per-session advisor model (the Claude Code "Advisor" picker). */
  advisorModel?: string | null;
  /** Pick the advisor model. Same plumbing rationale as `onChangeFast`. */
  onChangeAdvisorModel?: (model: string | null) => Promise<void> | void;
};

/**
 * Task types that represent *processes* rather than agentic work. These are
 * surfaced in the "Running" section (alongside background shells) and kept
 * OUT of "Tasks" so a backgrounded shell never double-shows. Mirrors the
 * SDK's BackgroundTaskSummary kinds: shell → local_bash, monitor →
 * local_monitor. Agentic kinds (local_agent / local_workflow) stay in "Tasks".
 */
const PROCESS_TASK_TYPES = new Set(["local_bash", "local_monitor"]);

/** Terminal statuses — used to drop a shell whose process has ended. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);

const TASK_TONES: Record<string, string> = {
  pending: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  failed: "border-red-500/30 bg-red-500/10 text-red-200",
  killed: "border-red-500/30 bg-red-500/10 text-red-200",
  stopped: "border-amber-500/30 bg-amber-500/10 text-amber-200",
};

/**
 * Row icon that reflects the task's *kind*, not a generic agent glyph: a
 * background shell gets a terminal, a monitor gets the activity pulse, and
 * agentic work (subagents / workflows) keeps the bot. Used anywhere a task
 * row renders (Tasks, Running, Recent) so a `local_bash` never looks like an
 * agent.
 */
function taskIcon(taskType?: string) {
  if (taskType === "local_bash") return Terminal;
  if (taskType === "local_monitor") return Activity;
  return Bot;
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m ${r}s`;
}

/**
 * Live wall-clock elapsed for a task row. While the task is running and we have
 * a client-stamped `startedAt`, this ticks every second (driven by the panel's
 * 1Hz `now`) — the visible "this is alive" signal a long-running, idle-turn
 * workflow otherwise lacks. Terminal/replayed tasks (no `startedAt`) fall back
 * to the SDK's `durationMs` snapshot. Returns null when neither is available.
 */
function taskElapsedSeconds(t: TaskInfo, now: number): number | null {
  if (t.startedAt && (t.status === "running" || t.status === "pending")) {
    return Math.max(0, (now - t.startedAt) / 1000);
  }
  if (t.durationMs != null) return t.durationMs / 1000;
  return null;
}

/** Trim the primary-arg subtitle to something that fits the activity rail. */
function compactArg(name: string, arg: string): string {
  // For file_path-shaped strings, show just the basename — the full path is in the title attr.
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "Read") {
    const base = arg.split("/").pop() ?? arg;
    return base || arg;
  }
  return arg;
}

export function BackgroundTasksPanel({
  progress,
  tasks = {},
  sessionId,
  model,
  effort,
  permissionMode,
  cwd,
  usage,
  historicalTurnCount,
  ready = true,
  pending,
  pendingPermission,
  latestTodos,
  recentEdits,
  backgroundBashes,
  scheduledLoops,
  toolHistory,
  onOpenBash,
  onOpenContext,
  onCancelScheduledLoop,
  onAddTodos,
  onClearTodos,
  onUpdateTodoItem,
  onChangeModel,
  onChangeEffort,
  ultracode = false,
  onChangeUltracode,
  fastMode = false,
  onChangeFast,
  advisorModel = null,
  onChangeAdvisorModel,
  planUsage,
}: Props) {
  const [showCost, setShowCost] = useState(false);
  const [addTodosOpen, setAddTodosOpen] = useState(false);
  // 1Hz tick so wake-up staleness (now > fireAt + grace) is recomputed
  // every second — drives both the chip's disappearance and the
  // attention counter dropping. Without this, a stale wake-up would
  // keep counting toward the rail header badge until the panel
  // re-rendered for another reason.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const runningCount = toolHistory.filter((e) => !e.done).length;
  const visibleHistory = toolHistory.slice(0, 30);

  // Join key: a background shell shares its launching Bash `tool_use_id` with
  // the `tool_use_id` of its `local_bash` task. This map lets the Running
  // section resolve a shell's `taskId` (to stop it) and notice when its task
  // has gone terminal (to drop a stale "live" row).
  const taskByToolUseId = new Map<string, TaskInfo>();
  for (const t of Object.values(tasks)) {
    if (t.toolUseId) taskByToolUseId.set(t.toolUseId, t);
  }

  // "Tasks" = agentic work only (subagents + workflows). Process-like tasks
  // (shells / monitors) are partitioned out into "Running" below so nothing
  // double-shows.
  const subagents = Object.values(tasks)
    .filter(
      (t) =>
        (t.status === "running" || t.status === "pending") &&
        !PROCESS_TASK_TYPES.has(t.taskType ?? ""),
    )
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

  // Stop a single running task (B2.4). Self-contained fetch — the panel
  // already has `sessionId`, so we don't thread a callback through page.tsx.
  // Best-effort: a failure just leaves the task running (the row keeps its
  // status), which the SDK's own task_notification will eventually reconcile.
  const stopTask = (taskId: string) => {
    if (!sessionId) return;
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).catch(() => {});
  };
  const recent = Object.values(tasks)
    .filter((t) => t.status !== "running" && t.status !== "pending")
    .slice(-3)
    .reverse();
  // Live background shells. Beyond the explicit `killed` flag (set when the
  // agent calls KillBash), we also drop a shell whose matching `local_bash`
  // task has gone terminal — that catches a process that ended on its own so
  // the list doesn't show stale "live" rows. (A shell killed fully
  // out-of-band with no task event can still linger briefly — a known gap.)
  const runningBashes = Object.values(backgroundBashes).filter((b) => {
    if (b.killed) return false;
    const t = taskByToolUseId.get(b.toolUseId);
    return !(t && TERMINAL_STATUSES.has(t.status));
  });
  // Non-shell process work (monitors) + any process task we have no captured
  // shell entry for. De-duped against shells by tool_use_id so a tracked shell
  // never appears twice.
  const bashToolUseIds = new Set(Object.values(backgroundBashes).map((b) => b.toolUseId));
  const runningProcessTasks = Object.values(tasks).filter(
    (t) =>
      (t.status === "running" || t.status === "pending") &&
      PROCESS_TASK_TYPES.has(t.taskType ?? "") &&
      !(t.toolUseId && bashToolUseIds.has(t.toolUseId)),
  );
  const runningProcs = runningBashes.length + runningProcessTasks.length;

  // The set of task ids the Stop-all button fans stop-task out over — agentic
  // tasks + process tasks + resolvable background shells, deduped. See
  // collectStoppableTaskIds for why this is narrower than `attention` and why
  // shells without a resolved task are excluded (keeps the confirm count honest).
  const stoppableTaskIds = collectStoppableTaskIds(
    subagents,
    runningProcessTasks,
    runningBashes,
    taskByToolUseId,
  );

  // Stop everything stoppable at once (fan-out over `stoppableTaskIds`).
  // Confirm first, matching the closeAllTabs idiom (native confirm). Wording
  // says "tasks" not "everything" so it isn't misleading about scheduled
  // loops, which this can't cancel. Fire-and-forget like the per-item
  // stopTask — each fetch already swallows errors and the SDK's
  // task_notification reconciles row status.
  const stopAll = () => {
    if (!sessionId || stoppableTaskIds.size === 0) return;
    if (
      !confirm(
        `Stop all ${stoppableTaskIds.size} running task${stoppableTaskIds.size === 1 ? "" : "s"}?`,
      )
    )
      return;
    stoppableTaskIds.forEach((id) => stopTask(id));
  };
  // Show cancelled loops too so the user gets closure feedback — they fade
  // to the muted tone but stay in the list until the section is
  // re-rendered without them (next session reset). Only ACTIVE ones count
  // toward attention though.
  //
  // Stale wake-ups (fire moment + grace has passed without the agent
  // chaining a fresh wake-up) are dropped entirely — there's no useful
  // closure feedback for "the loop ended" beyond the chip disappearing,
  // and leaving them visible as "due now" forever was actively confusing
  // (the user-reported bug: an armed-1h-ago entry stuck at "due now").
  const allLoops = Object.values(scheduledLoops)
    .filter((l) => !isStaleWakeup(l, now))
    .sort((a, b) => b.startedAt - a.startedAt);
  const activeLoopCount = allLoops.filter((l) => !l.cancelled).length;

  // Counter math: things needing attention. Includes scheduled loops so
  // the rail header reflects "things that will keep running" — the
  // user's complaint was that schedules had no visible cue at all.
  const attention =
    runningCount +
    subagents.length +
    (pendingPermission ? 1 : 0) +
    runningProcs +
    activeLoopCount;

  // All background work surfaced as "running" in the header: shells + monitors
  // (PROCESS_TASK_TYPES) PLUS agentic tasks (subagents / workflows). The latter
  // were previously invisible at the header level — a backgrounded workflow
  // runs while the turn reads idle, so neither the spinner nor the "N running"
  // cue fired and the user had no signal it was alive ("I don't know what's
  // going on"). Counting subagents here is the always-visible fix.
  const runningBg = runningProcs + subagents.length;

  // Reveal + scroll to a rail section (used by the header "running" cue). Force
  // the collapsible open by writing its persisted flag, then scroll — matches
  // CollapsibleSection's own storage protocol. Agentic work lives in "Tasks",
  // process work in "Running", so jump to whichever the cue represents.
  const reveal = (storageKey: string, anchorId: string) => {
    try {
      window.localStorage.setItem(`claudius.activity.${storageKey}.collapsed`, "0");
      window.dispatchEvent(new Event("claudius.activity.changed"));
    } catch {
      // ignore
    }
    document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const revealBackground = () =>
    subagents.length > 0 ? reveal("tasks", "activity-tasks") : reveal("running", "activity-running");

  // "Busy" covers session boot, turn-in-flight, AND backgrounded work that
  // outlives the turn (workflows/agents/shells) — so the spinner keeps saying
  // "something is happening" even after the turn that launched it ends.
  const busy = !ready || pending || runningBg > 0;

  return (
    <div data-pane-name="right-rail" className="flex h-full w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 text-xs">
        <Activity className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="font-medium">Activity</span>
        {busy && (
          <Loader2
            className="h-3 w-3 animate-spin text-[var(--accent)]"
            aria-label={!ready ? "Starting session" : "Claude is working"}
          />
        )}
        {busy && (
          <span className="text-[10px] font-medium text-[var(--accent)]">
            {!ready ? "Starting…" : "Working…"}
          </span>
        )}
        {runningBg > 0 && (
          <button
            type="button"
            onClick={revealBackground}
            title={subagents.length > 0 ? "Jump to running tasks" : "Jump to running processes"}
            aria-label={`${runningBg} background ${runningBg === 1 ? "task" : "tasks"} running — show them`}
            className="ml-auto flex items-center gap-1 rounded px-1 text-[10px] font-medium text-[var(--accent)] hover:bg-[var(--panel-2)]"
          >
            {subagents.length > 0 ? <Bot className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
            {runningBg} running
          </button>
        )}
        {sessionId && stoppableTaskIds.size > 0 && (
          <button
            type="button"
            onClick={stopAll}
            title="Stop all running tasks"
            aria-label={`Stop all ${stoppableTaskIds.size} running task(s)`}
            data-testid="stop-all-tasks"
            className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-red-400"
          >
            <CircleStop className="h-3 w-3" />
          </button>
        )}
        <span className={cn("text-[var(--muted)]", runningBg > 0 ? "ml-1" : "ml-auto")}>
          {attention}
        </span>
      </div>
      {/* Notifications inbox sits OUTSIDE the scroll container — the rail's
          `overflow-y-auto` would otherwise clip the popover horizontally and
          half of it would render behind the chat area (see screenshot
          regression). Kept above the scrollable model/session card so the
          bar stays pinned under the Activity header. */}
      <div className="px-2 pt-2">
        <NotificationsDrawer />
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-2 pb-2">
        {/* Always-on group */}
        <SessionCard
          sessionId={sessionId}
          model={model}
          effort={effort}
          permissionMode={permissionMode}
          cwd={cwd}
          usage={usage}
          historicalTurnCount={historicalTurnCount}
          onOpenCost={() => setShowCost(true)}
          onChangeModel={onChangeModel}
          onChangeEffort={onChangeEffort}
          ultracode={ultracode}
          onChangeUltracode={onChangeUltracode}
          fastMode={fastMode}
          onChangeFast={onChangeFast}
          advisorModel={advisorModel}
          onChangeAdvisorModel={onChangeAdvisorModel}
        />
        <ContextBar sessionId={sessionId} pending={pending} onOpenContext={onOpenContext} />
        <TokenMeter usage={usage} />

        <div className="mb-3 border-t border-[var(--border)]/40" />

        {/* Active group — render only when there's something to show. */}
        <PermissionPending request={pendingPermission} />

        {(latestTodos.length > 0 || onAddTodos) && (
          <CollapsibleSection
            storageKey="todos"
            label="To-dos"
            badge={`(${latestTodos.length})`}
            action={
              onAddTodos || onClearTodos ? (
                <div className="flex items-center gap-0.5">
                  {/* Clear only shows when there's something to clear — an
                      empty list with just the "+ Add" affordance doesn't
                      need an eraser. Stays narrow + iconic to fit alongside +. */}
                  {onClearTodos && latestTodos.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onClearTodos();
                      }}
                      data-testid="todos-clear-button"
                      aria-label="Clear todos"
                      title="Clear this list — the agent will start fresh next time it tracks todos"
                      className="flex h-4 w-4 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
                    >
                      <Eraser className="h-3 w-3" />
                    </button>
                  )}
                  {onAddTodos && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddTodosOpen((v) => !v);
                      }}
                      data-testid="todos-add-button"
                      aria-label="Add tasks"
                      title="Add tasks (asks the agent to update its todo list)"
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
                        addTodosOpen && "bg-[var(--panel-2)] text-[var(--foreground)]",
                      )}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ) : null
            }
          >
            {addTodosOpen && onAddTodos && (
              <AddTodosForm
                onSubmit={async (texts) => {
                  await onAddTodos(texts);
                  setAddTodosOpen(false);
                }}
                onCancel={() => setAddTodosOpen(false)}
              />
            )}
            {latestTodos.length > 0 ? (
              <TodoList todos={latestTodos} onUpdateItem={onUpdateTodoItem} />
            ) : !addTodosOpen ? (
              <div className="px-1 py-1 text-[10px] text-[var(--muted)]">
                No tasks yet. Click + to add.
              </div>
            ) : null}
          </CollapsibleSection>
        )}

        {subagents.length > 0 && (
          <CollapsibleSection storageKey="tasks" label="Tasks" badge={`(${subagents.length})`}>
            <ul id="activity-tasks" className="space-y-1">
              {subagents.map((t) => {
                const Icon = taskIcon(t.taskType);
                const elapsed = taskElapsedSeconds(t, now);
                return (
                <li
                  key={t.taskId}
                  className={cn(
                    "rounded-md border px-2 py-1.5",
                    TASK_TONES[t.status] ?? TASK_TONES.running,
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <Icon className="h-3 w-3" />
                    <span className="truncate font-mono">{t.workflowName ?? t.taskType ?? "Task"}</span>
                    <span className="ml-auto text-[10px]">{t.status}</span>
                    {sessionId && (
                      <button
                        onClick={() => stopTask(t.taskId)}
                        title="Stop this task"
                        aria-label="Stop this task"
                        className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
                      >
                        <CircleStop className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {t.description && (
                    <div className="mt-0.5 line-clamp-2 text-[10px] opacity-80">{t.description}</div>
                  )}
                  {/* AI-generated live progress summary (SDK
                      agentProgressSummaries). Refreshes ~30s while the
                      subagent runs; distinct from the static `description`. */}
                  {t.summary && t.summary !== t.description && (
                    <div className="mt-0.5 line-clamp-2 text-[10px] italic opacity-70">
                      {t.summary}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] opacity-70">
                    {t.totalTokens != null && <span>{t.totalTokens.toLocaleString()} tok</span>}
                    {t.toolUses != null && <span>{t.toolUses} tools</span>}
                    {/* Live ticking wall-clock while running (parity with the
                        background-shell box); the SDK `durationMs` snapshot is
                        the fallback for replayed/terminal rows. */}
                    {elapsed != null && <span className="tabular-nums">{fmtElapsed(elapsed)}</span>}
                    {t.lastToolName && <span>· {t.lastToolName}</span>}
                  </div>
                </li>
                );
              })}
            </ul>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          storageKey="tools"
          label="Tools"
          badge={
            toolHistory.length
              ? runningCount > 0
                ? `(${runningCount} running · ${toolHistory.length})`
                : `(${toolHistory.length})`
              : undefined
          }
        >
          {visibleHistory.length === 0 ? (
            <div className="px-2 py-3 text-center text-[10px] text-[var(--muted)]">
              No tools used yet.
            </div>
          ) : (
            <ul className="scroll-thin max-h-64 space-y-1 overflow-y-auto pr-1">
              {visibleHistory.map((e) => {
                const live = progress[e.toolUseId];
                // For finished entries we use the recorded duration; for live
                // ones we lean on tool_progress (which ticks server-side). If
                // neither is available (very brief tool, or progress events
                // not flowing), we show no time rather than a stale snapshot.
                const elapsedSeconds: number | null = e.done && e.endedAt
                  ? (e.endedAt - e.startedAt) / 1000
                  : live
                    ? live.elapsedSeconds
                    : null;
                const tone = e.isError
                  ? "border-red-500/30 bg-red-500/5"
                  : e.done
                    ? "border-[var(--border)] bg-[var(--panel-2)]/40"
                    : "border-sky-500/30 bg-sky-500/5";
                const StatusIcon = e.isError ? AlertTriangle : e.done ? Check : Loader2;
                const iconClass = e.isError
                  ? "text-red-400"
                  : e.done
                    ? "text-emerald-400"
                    : "animate-spin text-sky-400";
                // Synthetic thinking rows have no `primaryArg` (no tool
                // input to summarize) and use the brain glyph rather than
                // the wrench — they're a phase of the model's turn, not a
                // tool invocation.
                const isThinking = e.kind === "thinking";
                const KindIcon = isThinking ? Brain : Wrench;
                const arg = !isThinking && e.primaryArg
                  ? compactArg(e.toolName, e.primaryArg)
                  : undefined;
                return (
                  <li
                    key={e.toolUseId}
                    className={cn("rounded-md border px-2 py-1.5", tone)}
                    title={isThinking ? undefined : e.primaryArg}
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <StatusIcon className={cn("h-3 w-3 shrink-0", iconClass)} />
                      <KindIcon className="h-3 w-3 shrink-0 text-[var(--muted)] opacity-70" />
                      <span className="truncate font-mono">{e.toolName}</span>
                      {isThinking && !e.done && e.estimatedThinkingTokens != null && (
                        <span className="shrink-0 text-[10px] text-sky-400/70" title="Estimated thinking tokens (approximate)">
                          ~{e.estimatedThinkingTokens >= 1000
                            ? `${(e.estimatedThinkingTokens / 1000).toFixed(1)}k`
                            : e.estimatedThinkingTokens} tok
                        </span>
                      )}
                      {elapsedSeconds != null && (
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--muted)]">
                          {fmtElapsed(elapsedSeconds)}
                        </span>
                      )}
                    </div>
                    {arg && (
                      <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">
                        {arg}
                      </div>
                    )}
                    {e.parentToolUseId && (
                      <div className="mt-0.5 text-[10px] text-[var(--muted)] opacity-60">
                        via subagent {e.parentToolUseId.slice(0, 8)}…
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsibleSection>

        {allLoops.length > 0 && (
          <CollapsibleSection
            storageKey="loops"
            label="Scheduled loops"
            badge={
              activeLoopCount > 0
                ? `(${activeLoopCount}${
                    allLoops.length > activeLoopCount
                      ? ` · ${allLoops.length - activeLoopCount} cancelled`
                      : ""
                  })`
                : `(${allLoops.length})`
            }
          >
            <ScheduledLoops items={allLoops} onCancel={onCancelScheduledLoop} />
          </CollapsibleSection>
        )}

        {runningProcs > 0 && (
          <CollapsibleSection storageKey="running" label="Running" badge={`(${runningProcs})`}>
            <div id="activity-running" className="space-y-1">
              <BackgroundBashes
                items={runningBashes}
                onPick={onOpenBash}
                getStopTaskId={(b) => taskByToolUseId.get(b.toolUseId)?.taskId}
                onStop={(taskId) => stopTask(taskId)}
              />
              {runningProcessTasks.length > 0 && (
                <ul className="space-y-1">
                  {runningProcessTasks.map((t) => (
                    <li
                      key={t.taskId}
                      className={cn(
                        "rounded-md border px-2 py-1.5",
                        TASK_TONES[t.status] ?? TASK_TONES.running,
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-xs">
                        <Activity className="h-3 w-3 shrink-0" />
                        <span className="truncate font-mono">
                          {t.workflowName ?? t.taskType ?? "Process"}
                        </span>
                        <span className="ml-auto text-[10px]">{t.status}</span>
                        {sessionId && (
                          <button
                            onClick={() => stopTask(t.taskId)}
                            title="Stop this process"
                            aria-label="Stop this process"
                            className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel)] hover:text-red-400"
                          >
                            <CircleStop className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      {t.description && (
                        <div className="mt-0.5 line-clamp-2 text-[10px] opacity-80">
                          {t.description}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* History group */}
        {(recentEdits.length > 0 || recent.length > 0) && (
          <div className="mb-3 border-t border-[var(--border)]/40" />
        )}

        {recentEdits.length > 0 && (
          <CollapsibleSection storageKey="edits" label="Recent edits">
            <RecentEdits items={recentEdits} />
          </CollapsibleSection>
        )}

        {recent.length > 0 && (
          <CollapsibleSection storageKey="recent" label="Recent">
            <ul className="space-y-1">
              {recent.map((t) => {
                const Icon = taskIcon(t.taskType);
                return (
                <li
                  key={t.taskId}
                  className={cn("rounded-md border px-2 py-1 text-[10px]", TASK_TONES[t.status])}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3" />
                    <span className="truncate font-mono">{t.description}</span>
                    <span className="ml-auto">{t.status}</span>
                  </div>
                </li>
                );
              })}
            </ul>
          </CollapsibleSection>
        )}
      </div>

      {showCost && usage && (
        <CostOverlay usage={usage} model={model} planUsage={planUsage} onClose={() => setShowCost(false)} />
      )}
    </div>
  );
}
