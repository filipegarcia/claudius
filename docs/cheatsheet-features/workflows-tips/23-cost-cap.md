# Cost cap (--max-budget-usd)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`--max-budget-usd` sets a spending ceiling for the session; once reached, the agent stops to avoid runaway cost.

## Claudius today
`components/workspaces/WorkspaceForm.tsx` exposes a "Spend cap (USD)" input (state `defaultBudget`, persisted as `defaults.maxBudgetUsd` per `lib/shared/session-defaults.ts`). When the cap is hit, `components/chat/CapBreachBanner.tsx` shows "Session spending cap reached… Send is paused" with a one-day override. The cost surfaces live on `app/[workspaceId]/cost/page.tsx` and `components/overlays/CostOverlay.tsx`.

## Decision
Already covered. The budget ceiling is a workspace-default field (`maxBudgetUsd`) in `WorkspaceForm.tsx`, enforced with the `CapBreachBanner` pause/override UI. No new UI needed.
