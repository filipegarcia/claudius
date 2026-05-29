# Project settings (.claude/settings.json)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
The project-shared settings file at `.claude/settings.json`, committed to the
repo so a team shares the same defaults, permissions, hooks and MCP servers.

## Claudius today
Editable in the browser via the Settings page "Project" scope tab, which reads
and writes the workspace's `.claude/settings.json`. The path resolves through
`pathFor("project", projectCwd)` in `lib/server/settings.ts`, guarded by
`assertWithin` so it always stays inside the workspace.

## Decision
ALREADY_EXISTS. Covered by `app/settings/page.tsx` (Project scope tab) backed by
`app/api/settings/full/route.ts` and `lib/server/settings.ts`. No new surface
needed.
