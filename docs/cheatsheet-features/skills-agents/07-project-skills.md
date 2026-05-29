# Project skills (.claude/skills/<name>/)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
Project-scoped skills live in `<cwd>/.claude/skills/<name>/SKILL.md` and are available to anyone working in that project.

## Claudius today
The Skills page (`app/[workspaceId]/skills/page.tsx`) has a "Project (.claude/skills)" scope. The server resolves project skills at `<projectCwd>/.claude/skills/<name>/SKILL.md` (`skillsDir`/`skillPath` in `lib/server/skills.ts`), and `app/api/skills/route.ts` lists/reads/writes them. The page browses, creates, edits, and deletes project skills, with a workspace/account ScopeToggle.

## Decision
ALREADY_EXISTS. Covered by the project scope of `app/[workspaceId]/skills/page.tsx` backed by `lib/server/skills.ts` and `app/api/skills/`.
