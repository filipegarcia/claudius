# Stale TaskCreate/TaskUpdate gentle nudge (teammates)

**Source:** Claude Code TUI — input keyword nudge
**Status:** MISSING

## What it is
The team/coordinator counterpart to the stale-TodoWrite nudge: when running in team mode (gated by `AM()`), after N turns without `TaskCreate` or `TaskUpdate` calls the harness injects a `task_reminder` system message, dumps the current task list inline (`#${id}. [${status}] ${subject}`), and suggests adding new tasks, flipping status to `in_progress`/`completed`, or pruning stale entries. Phrased as low-pressure:

> The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using `TaskCreate` to add new tasks and `TaskUpdate` to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.

## Claudius today
Not surfaced in Claudius. The `stale-task-tools` kind is already reserved in the `ReminderKind` union in `lib/server/system-reminders.ts:25`, and `lib/server/session.ts:994` explicitly calls it out as a separate parity feature ("the TaskCreate / TaskUpdate flow is a separate parity feature, so those tools deliberately do NOT reset [the TodoWrite] counter") — but no turn-counter, threshold, or `queueReminder("stale-task-tools", ...)` call exists yet. `lib/client/use-session.ts` and `lib/server/session.ts` already ingest `TaskCreate`/`TaskUpdate` tool blocks for the right-rail todos snapshot (`components/chat/TodosBanner.tsx`, `widgets/TodoList.tsx`), and Claudius has no `AM()`-equivalent "team mode" gate distinct from the regular subagent flow.

## Decision
MISSING. The kind is scaffolded in the reminder union but the trigger, threshold, and body string are not implemented, and there is no team/coordinator session concept to gate it behind. Worth wiring alongside feature 31 (stale TodoWrite) so both nudges share one turn-counter scaffold in `Session`, with the team-mode gate defined as "this session has at least one TaskCreate in history"; otherwise leave to the SDK if/when it ships there.
