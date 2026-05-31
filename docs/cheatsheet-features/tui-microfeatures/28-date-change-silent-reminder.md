# Date-change ambient system-reminder

**Source:** Claude Code TUI — ambient system-reminder (session lifecycle)
**Status:** MISSING

## What it is
When the calendar date rolls over mid-session, the Claude Code harness silently injects a `<system-reminder>` updating Claude's notion of "today" — and explicitly instructs the model not to surface the rollover to the user, on the assumption that they already know. The literal string in the CLI binary is:

> `The date has changed. Today's date is now \n. DO NOT mention this to the user explicitly because they are already aware.`

The `\n` is the placeholder where the harness interpolates the new date; the reminder is ambient (model-only), not a user-visible banner.

## Claudius today
Not surfaced in Claudius. `lib/server/session.ts` instantiates a session and feeds user messages straight into the SDK without any wall-clock watcher, and `lib/shared/tips.ts` has no time-of-day or date-rollover trigger. Grepping for `date has changed`, `Today's date`, and `are already aware` across `lib/`, `components/`, and `app/` returns zero hits — the only `currentDate` reference is `lib/shared/cron.ts` passing `currentDate` to `CronExpressionParser.parse`, which is unrelated. The natural home would be a small interval in `lib/server/session.ts` that, on date change, pushes a synthetic `system-reminder` content block into the next user turn (or directly into the SDK's input stream).

## Decision
MISSING. Claudius leaves "today" entirely to whatever the SDK / model already knows at session start, and never re-syncs the date for long-lived sessions. Worth adding only for sessions that span midnight — a per-session timer in `lib/server/session.ts` that compares the last-seen local date against `new Date()` on each user turn and prepends a `system-reminder`-style block when they differ would mirror the CLI behavior with minimal surface area. Low priority unless multi-day sessions become common in Claudius.
