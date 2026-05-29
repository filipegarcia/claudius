# Recurring task (/loop 5m)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`/loop 5m <prompt>` re-runs a prompt or slash command on a fixed interval (omit the interval to let the model self-pace).

## Claudius today
`/loop` is a native command in `lib/shared/slash-commands.ts` (`argsHint: "[interval] [prompt]"`). The Schedule page (`app/[workspaceId]/schedule/page.tsx`) surfaces both durable cron jobs and live "session loops" — the latter polled from `app/api/schedule/session-loops/route.ts`, armed via the SDK's `CronCreate`/`ScheduleWakeup` tools, with a cancel path (`session-loops/cancel`). `components/panels/widgets/ScheduledLoops.tsx` shows active loops in the rail.

## Decision
Already covered. The Schedule page plus the session-loops API and `ScheduledLoops` widget are the browser surface for recurring/interval tasks, and `/loop` is registered as a command. No new UI needed.
