# CLAUDE.md personal

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
The user-global memory file at `~/.claude/CLAUDE.md`, applied across all projects.

## Claudius today
Surfaced on the **Memory** page as the `user` scope (`app/[workspaceId]/memory/page.tsx`, `SCOPE_META.user` → "User", hint `~/.claude/CLAUDE.md`). The page's account/workspace ScopeToggle filters to show the user scope under "account". Backed by `lib/server/claudemd.ts` (`pathFor(scope: "user")` → `join(homedir(), ".claude", "CLAUDE.md")`).

## Decision
ALREADY_EXISTS. The user-global CLAUDE.md is the `user` scope in the Memory editor, with full read/write/resolve and an existence indicator. No new surface needed.
