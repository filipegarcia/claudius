# 'ultrathink' prose keyword injects deeper-reasoning reminder

**Source:** Claude Code TUI — input keyword nudge
**Status:** ALREADY_EXISTS

## What it is
When the user prompt contains the bare word `ultrathink` (case-insensitive, on word boundaries), the TUI injects a per-turn `<system-reminder>` that lifts the reasoning budget for just that turn:

> The user included the keyword "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.

Distinct from `/effort max` because it is a transient single-turn bump triggered by a word in prose, not a sticky config change. Grounded in the `\bultrathink\b` regex and `ultrathink-active` identifier present alongside the reminder string in the CLI binary.

## Claudius today
Covered end-to-end. `ultrathinkReminderBody` in `lib/server/session.ts` runs the `\bultrathink\b` (case-insensitive) scan on each outgoing user prompt and returns the literal CLI reminder body when it matches; `Session.sendInput` then calls `queueReminder(this, "ultrathink-prose", body)` against the shared next-turn channel in `lib/server/system-reminders.ts` (the `"ultrathink-prose"` kind is registered in the `ReminderKind` union). The block rides the same `takePendingReminders` drain as the goal / date-change / mid-turn nudges, so it lands on THIS turn's wrapper sequence — placed after the slash-command early-return so `/compact` etc. never burn a reminder onto a synthetic invocation. Boundary behavior (`ultrathinking` must NOT match, `Ultrathink.` must) is pinned by `tests/unit/ultrathink-reminder.test.ts`.

## Decision
ALREADY_EXISTS. The prose-keyword scanner, the canonical reminder body, the single-turn queue/drain ordering, and the regex boundary contract are all implemented and tested. The sticky `/effort max` browser equivalent remains available via `components/panels/widgets/ModelPicker.tsx` (see `workflows-tips/05-ultrathink-max-effort.md`), but the TUI-specific transient bump now has true parity in Claudius — no follow-up needed.
