# /permissions

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/permissions` views and updates the allow / ask / deny permission rules.

## Claudius today
Dedicated workspace-scoped page at `app/[workspaceId]/permissions/page.tsx`
(SideNav "permissions" tile, with a bare-path redirect stub at
`app/permissions/page.tsx`). It edits allow / ask / deny rules across User /
Project / Local scopes with an account/workspace scope toggle, rule-syntax
hints (`Bash(npm run *)`, `Read(./src/**)`, `WebFetch(domain:...)`, etc.), and
writes through `lib/client/usePermissions.ts` + the
`/api/settings/permissions` route. (The live per-turn permission *mode* —
default / acceptEdits / plan / bypass — is a separate chat control via
`/api/sessions/[id]/mode`.)

## Decision
ALREADY_EXISTS. `app/[workspaceId]/permissions/page.tsx` is the direct browser
equivalent of `/permissions` — view and update allow/ask/deny rules per scope.
No new surface needed.
