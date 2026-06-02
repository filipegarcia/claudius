# Agent-Spawned Shell Tasks Killed on Agent Exit

**Source:** Claude Code TUI — tasks-teammate
**Status:** ALREADY_EXISTS

## What it is
When a `LocalAgentTask` exits, `killShellTasksForAgent` walks `AppState.tasks` and kills any still-running `local_bash` task tagged with that `agentId`, so a subagent that backgrounded a long `bun run build` or `tail -f` doesn't leave the shell running after its parent has finished. The cleanup logs `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)` (`tasks/LocalShellTask/killShellTasks.ts`, two `binary_grep` hits) and also purges any queued notifications addressed to the dead `agentId`.

## Claudius today
Claudius doesn't run shell tasks itself — `local_bash` / `local_agent` lifetimes are owned by the agent SDK, and Claudius only sees the resulting events. The session manager exposes a thin `stopTask(taskId)` shim (`lib/server/session.ts:3225-3233`) that just forwards to `this.query.stopTask(taskId)`, so when the SDK's `killShellTasksForAgent` fires inside the harness it surfaces in Claudius as the normal `task_notification` (status `stopped`) the rail already consumes via `lib/client/task-status.ts` and `components/panels/BackgroundTasksPanel.tsx`. The `SubagentStop` hook event is enumerated in `lib/shared/hook-events.ts:75` ("When a subagent finishes."), but there is no parent-agent → child-shell linkage on the Claudius side: `parentAgentId` / `spawnedByAgent` return zero hits across `lib/`, and `collectStoppableTaskIds` in `lib/client/task-status.ts:180` partitions the rail by SDK kind (subagents / process-tasks / shells) without tracking who spawned what. Because the SDK kills the orphan and emits the `task_notification` before Claudius is told the agent stopped, the rail's shell pill simply disappears at the right moment without Claudius needing to do anything.

## Decision
ALREADY_EXISTS (by delegation). The orphan-cleanup is internal to the agent SDK (`tasks/LocalShellTask/killShellTasks.ts`) and reaches Claudius pre-resolved via `task_notification` → `BackgroundTasksPanel`. No host-side work is required so long as `session.stopTask` keeps forwarding to `query.stopTask`. The only follow-up worth noting is observability: if a future debugging pass wants to surface the "killed because parent exited" reason that the TUI logs internally, Claudius would need the SDK to thread that reason through `task_notification` — without it, the rail can only show "stopped" and can't distinguish a user-initiated stop from a parent-agent cascade.
