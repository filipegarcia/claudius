# --max-budget-usd

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--max-budget-usd <n>` caps the dollar spend for the session; the agent stops when the cap is hit.

## Claudius today
The Cost page hosts a LimitsPanel (`components/cost/LimitsPanel.tsx`) with both a per-session USD cap (`sessionUsd`) and a project daily cap (`projectDailyUsd`), backed by `lib/client/useLimits`. A per-workspace default `maxBudgetUsd` is also editable in `components/workspaces/WorkspaceForm.tsx` and threaded into session creation via `app/api/sessions/route.ts`.

## Decision
Already covered. The session-budget cap exists as a Cost-page limit and as a workspace default applied at session creation. No new UI needed.
