# Auto-mode exit reminder

**Source:** Claude Code TUI — permission flow (mode-transition system reminder)
**Status:** ALREADY_EXISTS

## What it is
When the user Shift+Tabs out of auto-accept (auto) mode, the CLI injects a system reminder into the conversation so Claude shifts back to a more interactive posture:

> `## Exited Auto Mode`
> `You have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.`

The handler lives next to a sibling `plan_mode_exit` reminder, so both mode-exit transitions get a matching nudge.

## Claudius today
Wired end-to-end. `lib/server/session.ts` exports `autoModeExitReminderBody()` (lines 289-296), which returns the CLI's verbatim `## Exited Auto Mode` prose — including the "ask clarifying questions when the approach is ambiguous rather than making assumptions" clause. `setPermissionMode()` (lines 2340-2379) captures `wasAuto = this.permissionMode === "auto"` *before* the mode write, and on an `auto -> non-auto` transition (`wasAuto && mode !== "auto"`) calls `queueReminder(this, "auto-mode-exit", autoModeExitReminderBody())` so the next user turn carries the reminder. The composer-side trigger is `components/chat/ModeSelector.tsx` (the Shift+Tab cycle, including `auto`), and the verbatim prose is pinned by `tests/unit/auto-mode-exit-reminder.test.ts`.

## Decision
ALREADY_EXISTS. The CLI's auto-mode exit reminder is mirrored 1:1 in `lib/server/session.ts`: same verbatim string, same transition gate (only fires on `auto -> non-auto`, redundant `setPermissionMode("auto")` while already in auto won't re-fire), and a unit test guards the load-bearing phrasing. Nothing further to build.
