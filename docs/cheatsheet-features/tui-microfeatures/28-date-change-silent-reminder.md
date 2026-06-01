# Date-change ambient system-reminder

**Source:** Claude Code TUI — ambient system-reminder (session lifecycle)
**Status:** ALREADY_EXISTS

## What it is
When the calendar date rolls over mid-session, the Claude Code harness silently injects a `<system-reminder>` updating Claude's notion of "today" — and explicitly instructs the model not to surface the rollover to the user, on the assumption that they already know. The literal string in the CLI binary is:

> `The date has changed. Today's date is now \n. DO NOT mention this to the user explicitly because they are already aware.`

The `\n` is the placeholder where the harness interpolates the new date; the reminder is ambient (model-only), not a user-visible banner.

## Claudius today
Covered. `lib/server/session.ts` exposes two pure helpers — `localDateKey(d)` (LOCAL `YYYY-MM-DD`, not `toISOString().slice(0,10)`, to avoid firing the reminder a fixed number of hours off the user's wall clock) and `dateChangeReminderBody(prevKey, now)` which returns the verbatim CLI body — `The date has changed. Today's date is now <today.toDateString()>. DO NOT mention this to the user explicitly because they are already aware.` — or `null` on same-day. `Session.sendInput` baselines `this.lastSeenLocalDate` on the first real turn (so the SDK's start-of-session date isn't double-announced) and on every subsequent turn compares against today's local key; on rollover it calls `queueReminder(this, "date-change", body)` in `lib/server/system-reminders.ts`, riding the same drain as the ultrathink scan so the ambient block lands on the next turn. `tests/unit/date-change-reminder.test.ts` pins same-day → null, next-day → literal suppression clause, the `toDateString()` rendering shape, and the year-boundary case.

## Decision
ALREADY_EXISTS. The CLI's date-change ambient reminder is mirrored end-to-end — local-calendar key, verbatim "DO NOT mention this" clause, lazy baseline on the first turn, and queued through the same `<system-reminder>` channel as the rest of the parity reminders. No follow-up needed; revisit only if the CLI changes the literal body or starts surfacing the rollover visibly.
