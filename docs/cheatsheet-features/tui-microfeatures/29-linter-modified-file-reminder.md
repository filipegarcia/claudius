# Linter-modified-file reminder

**Source:** Claude Code TUI — hooks
**Status:** ALREADY_EXISTS

## What it is
If a formatter or linter touches a file Claude just wrote, the next turn carries an ambient `<system-reminder>` telling Claude the change `was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware.` The budget-aware variant omits the diff with `The diff was omitted because other modified files in this turn already exceeded the snippet budget; use the Read tool if you need the current content.`

## Claudius today
Implemented end-to-end in `lib/server/session.ts`. The programmatic `PostToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit` snapshots a SHA-256 of each touched path into `postWriteSnapshots` (in-memory, keyed to the Session). At the next real user turn `flushLinterModifiedReminder()` re-hashes each path and, for every mismatched file, calls the pure helper `linterModifiedReminderBody()` — which emits the verbatim CLI prose ("was modified, either by the user or by a linter…", "don't revert it unless the user asks you to", "Don't tell the user this, since they are already aware") — and `queueReminder(this, "linter-modified-file", body)` into the shared `system-reminders.ts` channel. It rides the same drain as the date-change / ultrathink / goal nudges at the `inputQueue` prepend site. The `linter-modified-file` `ReminderKind` is registered in `lib/server/system-reminders.ts`; the prose contract is pinned by `tests/unit/linter-modified-reminder.test.ts`.

## Decision
ALREADY_EXISTS. The reminder is an agent-internal nudge — the user is explicitly not told — so there is no UI to render. The hash-diff + drain pipeline already matches the CLI behavior for the "don't revert it" half; the budget-omitted variant isn't reproduced because Claudius never inlines a diff in the first place (the reminder names the path and lets the model `Read` it). No follow-up needed.
