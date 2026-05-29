# Personal skills (~/.claude/skills/<name>/)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
User-scoped ("personal") skills live in `~/.claude/skills/<name>/SKILL.md` and apply across every project for that user.

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) exposes a "User (~/.claude/skills)" scope, selectable via the account/workspace ScopeToggle. The server resolves user skills at `join(homedir(), ".claude", "skills")` (`skillsDir("user", ...)` in `lib/server/skills.ts`); `app/api/skills/route.ts` covers list/read/write and the delete route covers removal.

## Decision
ALREADY_EXISTS. Covered by the user scope of `app/[workspaceId]/skills/page.tsx` backed by `lib/server/skills.ts` and `app/api/skills/`.
