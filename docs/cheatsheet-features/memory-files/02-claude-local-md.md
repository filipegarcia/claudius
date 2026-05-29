# CLAUDE.local.md

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
Local personal project notes at `./CLAUDE.local.md`, gitignored so they stay off the shared repo. Loaded into the session alongside the team CLAUDE.md.

## Claudius today
Surfaced on the **Memory** page as the `local` scope tab (`app/[workspaceId]/memory/page.tsx`). `SCOPE_META.local` labels it "Local" with the hint `<cwd>/CLAUDE.local.md (gitignored)`. Backed by `lib/server/claudemd.ts` (`pathFor(scope: "local")` → `<cwd>/CLAUDE.local.md`) via `app/api/claudemd/route.ts`.

## Decision
ALREADY_EXISTS. The `local` scope is one of the four editable CLAUDE.md scopes in the Memory editor, with full read/write/resolve. No new surface needed.
