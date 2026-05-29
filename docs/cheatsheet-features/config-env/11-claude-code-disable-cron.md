# CLAUDE_CODE_DISABLE_CRON

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Globally disables Claude Code's scheduled (cron) task execution.

## Claudius today
Scheduling is a first-class feature with its own browser surface: the global `app/schedule/page.tsx` and the workspace-scoped `app/[workspaceId]/schedule/page.tsx`, backed by `lib/server/scheduler.ts` and the `app/api/schedule/*` routes (create/list/delete, run-now, runs, session-loops). Individual routines can be enabled/disabled and removed from these pages, so a user has direct control over whether scheduled work runs — finer-grained than the all-or-nothing env switch.

## Decision
ALREADY_EXISTS. The Schedule pages (`app/schedule/page.tsx`, `app/[workspaceId]/schedule/page.tsx`) plus the `app/api/schedule/*` API let users disable/delete scheduled tasks per routine, which subsumes the global "disable cron" env var with a better, more granular UX. No new surface needed.
