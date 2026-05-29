# --permission-mode

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--permission-mode <mode>` sets the permission mode for the session (default, acceptEdits, plan, bypassPermissions, etc.).

## Claudius today
The ModeSelector chat control (`components/chat/ModeSelector.tsx`) offers default / acceptEdits / auto / plan / dontAsk / bypassPermissions and posts to `app/api/sessions/[id]/mode/route.ts` (`session.setPermissionMode`). Workspace defaults (`components/workspaces/WorkspaceForm.tsx`) also set a default `permissionMode` applied at session creation.

## Decision
Already covered. The permission mode picker is a first-class chat control plus a workspace default. No new UI needed.
