"use client";

import { useState } from "react";
import { Activity, AlertTriangle, Bot, Brain, Check, Loader2, Plus, Wrench } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentTodo,
  BackgroundBash,
  RecentEdit,
  SessionUsage,
  TaskInfo,
  ToolHistoryEntry,
  ToolProgressInfo,
} from "@/lib/client/types";
import type { PermissionRequestEvent } from "@/lib/shared/events";
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
import { RecentEdits } from "./widgets/RecentEdits";
import { fmtMs } from "./widgets/format";
import { cn } from "@/lib/utils/cn";

type Props = {
  progress: Record<string, ToolProgressInfo>;
  tasks?: Record<string, TaskInfo>;
  sessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  cwd: string | null;
  usage: SessionUsage | null;
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
  toolHistory: ToolHistoryEntry[];
  /** Open the live-tail viewer for this bash. */
  onOpenBash?: (b: BackgroundBash) => void;
  /**
   * Ask the agent to append items to its TodoWrite list. The handler
   * should compose a prompt and pipe it through useSession.send (which
   * queues if a turn is in flight). Omitting this hides the `+` button.
   */
  onAddTodos?: (texts: string[]) => Promise<void> | void;
};

const TASK_TONES: Record<string, string> = {
  pending: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  failed: "border-red-500/30 bg-red-500/10 text-red-200",
  killed: "border-red-500/30 bg-red-500/10 text-red-200",
  stopped: "border-amber-500/30 bg-amber-500/10 text-amber-200",
};

function fmtElapsed(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m ${r}s`;
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
  toolHistory,
  onOpenBash,
  onAddTodos,
}: Props) {
  const [showCost, setShowCost] = useState(false);
  const [addTodosOpen, setAddTodosOpen] = useState(false);

  const runningCount = toolHistory.filter((e) => !e.done).length;
  const visibleHistory = toolHistory.slice(0, 30);
  const subagents = Object.values(tasks)
    .filter((t) => t.status === "running" || t.status === "pending")
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  const recent = Object.values(tasks)
    .filter((t) => t.status !== "running" && t.status !== "pending")
    .slice(-3)
    .reverse();
  const liveBashes = Object.values(backgroundBashes).filter((b) => !b.killed);

  // Counter math: things needing attention.
  const attention =
    runningCount + subagents.length + (pendingPermission ? 1 : 0) + liveBashes.length;

  // "Busy" covers session boot AND turn-in-flight. Drives the header spinner —
  // gives the user a always-visible "Claude is doing something" cue without
  // them having to glance at the tools list.
  const busy = !ready || pending;

  return (
    <div data-pane-name="right-rail" className="flex h-full w-72 flex-col border-l border-[var(--border)] bg-[var(--panel)]">
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
        <span className="ml-auto text-[var(--muted)]">{attention}</span>
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
          permissionMode={permissionMode}
          cwd={cwd}
          usage={usage}
          historicalTurnCount={historicalTurnCount}
          onOpenCost={() => setShowCost(true)}
        />
        <ContextBar sessionId={sessionId} pending={pending} />
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
              onAddTodos ? (
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
              <TodoList todos={latestTodos} />
            ) : !addTodosOpen ? (
              <div className="px-1 py-1 text-[10px] text-[var(--muted)]">
                No tasks yet. Click + to add.
              </div>
            ) : null}
          </CollapsibleSection>
        )}

        {subagents.length > 0 && (
          <CollapsibleSection storageKey="tasks" label="Tasks" badge={`(${subagents.length})`}>
            <ul className="space-y-1">
              {subagents.map((t) => (
                <li
                  key={t.taskId}
                  className={cn(
                    "rounded-md border px-2 py-1.5",
                    TASK_TONES[t.status] ?? TASK_TONES.running,
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <Bot className="h-3 w-3" />
                    <span className="truncate font-mono">{t.workflowName ?? t.taskType ?? "Task"}</span>
                    <span className="ml-auto text-[10px]">{t.status}</span>
                  </div>
                  {t.description && (
                    <div className="mt-0.5 line-clamp-2 text-[10px] opacity-80">{t.description}</div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] opacity-70">
                    {t.totalTokens != null && <span>{t.totalTokens.toLocaleString()} tok</span>}
                    {t.toolUses != null && <span>{t.toolUses} tools</span>}
                    {t.durationMs != null && <span>{fmtMs(t.durationMs)}</span>}
                    {t.lastToolName && <span>· {t.lastToolName}</span>}
                  </div>
                </li>
              ))}
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

        {liveBashes.length > 0 && (
          <CollapsibleSection storageKey="bashes" label="Background shells" badge={`(${liveBashes.length})`}>
            <BackgroundBashes items={liveBashes} onPick={onOpenBash} />
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
              {recent.map((t) => (
                <li
                  key={t.taskId}
                  className={cn("rounded-md border px-2 py-1 text-[10px]", TASK_TONES[t.status])}
                >
                  <div className="flex items-center gap-1.5">
                    <Bot className="h-3 w-3" />
                    <span className="truncate font-mono">{t.description}</span>
                    <span className="ml-auto">{t.status}</span>
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}
      </div>

      {showCost && usage && (
        <CostOverlay usage={usage} model={model} onClose={() => setShowCost(false)} />
      )}
    </div>
  );
}
