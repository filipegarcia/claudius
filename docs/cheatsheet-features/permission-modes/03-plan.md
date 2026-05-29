# plan

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** ALREADY_EXISTS

## What it is
A read-only mode: Claude investigates and produces a plan without running any tools that cause side effects, then proposes the plan for approval before acting.

## Claudius today
Defined in `components/chat/ModeSelector.tsx` (`plan`, "Read-only — produce a plan, no tool side effects", ListChecks icon) and allowed in `app/api/sessions/[id]/mode/route.ts`. Beyond the selector, plan mode has dedicated UI: `components/chat/PlanModeBanner.tsx` (sticky banner explaining the mode + an Exit button) and `components/overlays/PlanOverlay.tsx` (review/accept the produced plan, which flips the session to `acceptEdits`). Also offered as a workspace default in `components/workspaces/WorkspaceForm.tsx`.

## Decision
ALREADY_EXISTS — and more fully built out than the other modes. Covered by `components/chat/ModeSelector.tsx`, `components/chat/PlanModeBanner.tsx`, and `components/overlays/PlanOverlay.tsx`, with persistence through `app/api/sessions/[id]/mode/route.ts`. No new surface needed.
