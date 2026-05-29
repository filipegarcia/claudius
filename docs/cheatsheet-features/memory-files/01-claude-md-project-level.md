# CLAUDE.md project level

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
The team-shared, repo-checked-in project memory file at `./CLAUDE.md` (or `./.claude/CLAUDE.md`). Loaded into every session as standing project instructions.

## Claudius today
Fully surfaced on the **Memory** page (`app/[workspaceId]/memory/page.tsx`, SideNav tile `/memory`). The CLAUDE.md editor has scope tabs including `project` (`<cwd>/CLAUDE.md`) and `project-claude` (`<cwd>/.claude/CLAUDE.md`). Read/write goes through `app/api/claudemd/route.ts` → `lib/server/claudemd.ts` (`pathFor`, `readScope`, `writeScope`).

## Decision
ALREADY_EXISTS. Both project locations are first-class scopes in the Memory page editor (`pathFor` maps `project` → `<cwd>/CLAUDE.md` and `project-claude` → `<cwd>/.claude/CLAUDE.md`), with an existence dot, a per-scope path display, save, and a "Resolved" view. No new surface needed.
