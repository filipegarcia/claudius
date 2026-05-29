# Local settings (.claude/settings.local.json)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
The local-only, gitignored settings file at `.claude/settings.local.json` —
per-developer overrides that should not be committed (highest precedence among
user/project/local).

## Claudius today
Editable in the browser via the Settings page "Local" scope tab, which reads and
writes `.claude/settings.local.json`. Path resolution is `pathFor("local", …)`
in `lib/server/settings.ts`. The same scope tabs appear on the dedicated Hooks
and Permissions pages.

## Decision
ALREADY_EXISTS. Covered by `app/settings/page.tsx` (Local scope tab) backed by
`app/api/settings/full/route.ts` and `lib/server/settings.ts`. No new surface
needed.
