# Stale TaskCreate/TaskUpdate gentle nudge (teammates)

**Source:** Claude Code TUI — input keyword nudge
**Status:** MISSING

## What it is
The team/coordinator counterpart to the stale-TodoWrite nudge: when running in team mode (gated by `AM()`), after N turns without `TaskCreate` or `TaskUpdate` calls the harness injects a `task_reminder` system message, dumps the current task list inline (`#${id}. [${status}] ${subject}`), and suggests adding new tasks, flipping status to `in_progress`/`completed`, or pruning stale entries. Phrased as low-pressure:

> The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using `TaskCreate` to add new tasks and `TaskUpdate` to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.

## Claudius today
Not surfaced in Claudius. `lib/client/use-session.ts` already ingests `TaskCreate`/`TaskUpdate` tool blocks and folds them into the same todos snapshot rendered by `components/chat/TodosBanner.tsx` and the right-rail `widgets/TodoList.tsx`, but nothing in `lib/server/session.ts` tracks turn-distance since the last Task-tool call or injects a `task_reminder` user-message back into the agent's context. A natural home would be the same server-side hook in `lib/server/session.ts` that would carry the parallel `todo_reminder` (see `31-stale-todowrite-gentle-nudge.md`), gated on team/coordinator sessions.

## Decision
MISSING. This is a harness-internal prompt-injection behavior baked into the Claude Code binary, scoped to team mode, not a UI feature — Claudius would have to replicate it by tracking TaskCreate/TaskUpdate turn-distance in the session loop and injecting the reminder string itself. Only worth adding if/when Claudius grows a first-class team/coordinator mode; until then leave it to the SDK to handle if/when it ships there.
