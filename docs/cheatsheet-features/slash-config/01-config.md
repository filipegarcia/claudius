# /config

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/config` opens an interactive view of Claude Code's settings and lets you set
values that persist to `settings.json` (across User / Project / Local scopes).

## Claudius today
Fully implemented as the global Settings page at `app/settings/page.tsx`
(route `/settings`, reachable from the SideNav). It edits Claude Code's
`settings.json` across all three scopes via a User/Project/Local scope toggle,
offers both a form view and a Raw JSON view, a settings search filter, and a
curated catalog of known SDK keys plus a generic "Other" editor for any
remaining key. Persistence runs through `lib/server/settings.ts` and the
`/api/settings` route group (including import/export and per-scope writes).

## Decision
ALREADY_EXISTS. The Settings page (`app/settings/page.tsx`) is the browser
equivalent of `/config` — it reads and writes `settings.json` per scope with a
form + raw editor, exactly the persistence behavior the cheat-sheet entry
describes. No new surface needed.
