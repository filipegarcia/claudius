# Stale TodoWrite gentle nudge

**Source:** Claude Code TUI — input keyword nudge
**Status:** ALREADY_EXISTS

## What it is
After N real user turns without a `TodoWrite` tool_use, the harness injects a `todo_reminder` system message suggesting Claude consider tracking progress and prune stale items. The current todo contents are dumped inline so the model can clean them up. The wording is deliberately low-pressure:

> The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.

## Claudius today
Implemented server-side. `staleTodoReminderBody(todos)` in `lib/server/system-reminders.ts` emits the verbatim CLI prose and appends a JSON dump under `Current todos:` when the list is non-empty. `lib/server/session.ts` tracks `turnsSinceTodoWrite`, resets it whenever a `TodoWrite` tool_use lands (including disk-replayed ones via `captureSnapshotState`), and in `sendInput` queues a `"stale-todowrite"` reminder via `queueReminder` once the counter crosses `STALE_TODO_TURN_THRESHOLD` (15). `ReminderKind` in `lib/shared/events.ts` carries `"stale-todowrite"`, and `tests/unit/stale-todowrite-reminder.test.ts` pins the load-bearing "gentle reminder - ignore if not applicable" tail.

## Decision
ALREADY_EXISTS. The harness-internal injection is fully replicated: turn counter in `Session`, reset on TodoWrite tool_use, threshold-gated reminder body with inline todo dump. No new work needed unless the CLI's threshold drifts away from 15 turns.
