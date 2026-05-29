# /plan

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Enters plan mode directly — Claude does read-only planning and produces a plan before executing.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "plan"`, handler `native`, `argsHint: "[description]"`). The dispatcher calls `session.setPermissionMode("plan")` and optionally sends the description as the opening prompt. The state is surfaced by `PlanModeBanner` and reviewed via `PlanOverlay`, backed by `app/api/sessions/[id]/plan` and `.../mode`.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"plan"`, around line 778), `components/chat/PlanModeBanner.tsx`, `components/overlays/PlanOverlay.tsx`, and the plan/mode API routes. Plan mode is also selectable from the `ModeSelector` chat control.
