# Auto mode denied retry (/permissions Recent Retry)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** UI_WORTHY

## What it is
When auto mode auto-denies a tool action, `/permissions` keeps a "Recent" list of those denials so you can retry the action (and optionally add a standing allow rule) without retyping it.

## Claudius today
The permissions page (`app/[workspaceId]/permissions/page.tsx` + `lib/client/usePermissions.ts`) manages allow/ask/deny rules across user/project/local scopes, but it has **no** "Recent denials" list and no retry affordance. There is no server tracking of recently auto-denied actions, and no API route under `app/api/settings/permissions` or `app/api/sessions/[id]/permission` that returns a denial history.

## Decision
UI_WORTHY but **deferred — needs backend**. A "Recent denials / Retry" panel would live as a section on the existing permissions page (or a chat-side control near `PermissionPrompt`). It needs new backend plumbing first: the SDK/session must surface the recent auto-denial stream and expose a "retry this action" path, then the UI is a thin list with a Retry button and an "Allow always" shortcut. Until the session emits denial history, this is backend work, not a UI shell. Priority med.
