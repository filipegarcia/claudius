# Plan mode cycle (Shift+Tab)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Shift+Tab cycles the session's permission posture: Normal -> Auto-Accept -> Plan (read-only planning). Plan mode produces a plan with no tool side effects until you approve.

## Claudius today
The full permission-mode cycle lives in `components/chat/ModeSelector.tsx`, which renders a dropdown over all SDK modes (`default`, `acceptEdits`, `auto`, `plan`, `dontAsk`, `bypassPermissions`) and exposes `nextPermissionMode()` for Shift+Tab cycling. The control posts to `app/api/sessions/[id]/mode/route.ts`. A dedicated `components/chat/PlanModeBanner.tsx` surfaces the read-only state, and plan approvals resolve through `app/api/sessions/[id]/plan/route.ts`.

## Decision
Already covered. `ModeSelector` is the browser surface for the plan-mode cycle, with the mode button tooltip explicitly noting "Shift+Tab to cycle". No new UI needed.
