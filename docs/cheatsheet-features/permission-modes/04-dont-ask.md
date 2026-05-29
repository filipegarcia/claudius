# dontAsk

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** ALREADY_EXISTS

## What it is
A non-interactive mode that never prompts: anything not explicitly allowed by the configured permission rules is auto-denied. Useful for unattended runs where you want a hard "allowlist-only" posture.

## Claudius today
Defined in `components/chat/ModeSelector.tsx` (`dontAsk`, "Never prompt — auto-deny anything not pre-approved", ShieldAlert icon) and allowed in `app/api/sessions/[id]/mode/route.ts`. The allow/deny rules it relies on are managed by the existing permissions pages (`app/[workspaceId]/permissions/page.tsx` and `app/permissions/page.tsx`, backed by `app/api/settings/permissions/route.ts`).

## Decision
ALREADY_EXISTS. Selectable in the chat `ModeSelector` and persisted via `app/api/sessions/[id]/mode/route.ts`; the underlying allow/deny rules live on the permissions pages (`app/[workspaceId]/permissions/page.tsx`, `app/permissions/page.tsx`). No new surface needed.
