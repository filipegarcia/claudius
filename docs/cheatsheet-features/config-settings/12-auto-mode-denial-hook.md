# Auto-mode denial hook (PermissionDenied)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
A hook that fires on `PermissionDenied` — after a permission request is denied
(e.g. by auto-mode rules) — so you can log, notify, or react to the denial.

## Claudius today
Fully supported in the Hooks editor. `PermissionDenied` is in
`HOOK_EVENT_NAMES` / `HOOK_EVENTS` (`lib/shared/hook-events.ts`, categorized under
"Permissions") and is selectable as the Event in the `AddHookForm` on
`app/[workspaceId]/hooks/page.tsx`. Any handler type (command/http/prompt/agent/
mcp_tool) can be attached, persisted via `lib/server/hooks.ts`.

## Decision
ALREADY_EXISTS. Covered by `app/[workspaceId]/hooks/page.tsx` — select the
`PermissionDenied` event in Add Hook and attach a handler. No new surface needed.
