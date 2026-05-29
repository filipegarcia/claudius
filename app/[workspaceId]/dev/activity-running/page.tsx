"use client";

/**
 * Dev-only preview: the Activity rail's "Running" section (background shells +
 * monitor processes), the per-row Stop control, the stale-shell filter, and
 * the header "N running" cue. Mounts the REAL BackgroundTasksPanel with mock
 * props so we can screenshot the feature without a live Claude session.
 *
 * What the fixtures exercise:
 *   - two live shells, each with a matching running `local_bash` task → Stop
 *     button shows (the toolUseId→taskId join resolves)
 *   - a `local_monitor` process task → rendered in "Running" (not "Tasks")
 *   - a STALE shell whose `local_bash` task already completed → filtered OUT
 *     of "Running" (proves dead/stale detection)
 *   - a `local_agent` subagent → stays in "Tasks" (proves the partition)
 *
 * Wrapper testid: `activity-running-preview`.
 */

import { useState } from "react";
import { BackgroundTasksPanel } from "@/components/panels/BackgroundTasksPanel";
import type { BackgroundBash, TaskInfo } from "@/lib/client/types";

/** Shells anchored to real client time (set in an effect) so elapsed reads sensibly. */
function buildBashes(now: number): Record<string, BackgroundBash> {
  return {
    "tu-dev": { toolUseId: "tu-dev", command: "bun run dev", startedAt: now - 254_000 },
    "tu-serve": {
      toolUseId: "tu-serve",
      command: "bunx serve site -l 4321 --no-clipboard",
      startedAt: now - 74_000,
    },
    // Stale: its task has gone terminal below → should NOT render in "Running".
    "tu-stale": { toolUseId: "tu-stale", command: "pytest -q --watch", startedAt: now - 600_000 },
  };
}

const TASKS: Record<string, TaskInfo> = {
  // Matching tasks for the live shells — give them a taskId so Stop works.
  "task-dev": { taskId: "task-dev", toolUseId: "tu-dev", taskType: "local_bash", description: "bun run dev", status: "running" },
  "task-serve": { taskId: "task-serve", toolUseId: "tu-serve", taskType: "local_bash", description: "serve site", status: "running" },
  // The stale shell's task already finished → drops the shell from "Running".
  "task-stale": { taskId: "task-stale", toolUseId: "tu-stale", taskType: "local_bash", description: "pytest watcher", status: "completed" },
  // A monitor process → belongs in "Running", not "Tasks".
  "task-monitor": {
    taskId: "task-monitor",
    toolUseId: "tu-monitor",
    taskType: "local_monitor",
    description: "Watch CI run #4821 until it finishes",
    status: "running",
  },
  // An agentic subagent → must stay in "Tasks" (partition check).
  "task-agent": {
    taskId: "task-agent",
    toolUseId: "tu-agent",
    taskType: "local_agent",
    workflowName: "review",
    description: "Reviewing the auth refactor",
    status: "running",
    totalTokens: 184_200,
    toolUses: 37,
    durationMs: 96_000,
  },
};

export default function ActivityRunningPreview() {
  const [stopped, setStopped] = useState<string[]>([]);
  // Anchor shell start times to real client time via a lazy initializer (runs
  // once, no effect). Elapsed stays consistent because the widget's clock and
  // these start times share the same Date.now() base.
  const [bashes] = useState<Record<string, BackgroundBash>>(() => buildBashes(Date.now()));
  return (
    <div
      data-testid="activity-running-preview"
      className="flex h-screen items-stretch justify-end bg-[var(--background)]"
    >
      <div className="flex flex-col justify-start p-3 text-xs text-[var(--muted)]">
        <p className="max-w-xs">
          Stop clicks (mocked): <code data-testid="stopped-ids">{stopped.join(", ") || "none"}</code>
        </p>
      </div>
      <BackgroundTasksPanel
        progress={{}}
        tasks={TASKS}
        sessionId="preview-session"
        model="claude-sonnet-4-6"
        effort="high"
        permissionMode="default"
        cwd="/Users/dev/project"
        usage={null}
        ready
        pending
        pendingPermission={null}
        latestTodos={[]}
        recentEdits={[]}
        backgroundBashes={bashes}
        scheduledLoops={{}}
        toolHistory={[]}
        onOpenBash={(b) => setStopped((s) => [...s, `open:${b.toolUseId}`])}
      />
    </div>
  );
}
