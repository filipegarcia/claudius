# User settings (~/.claude/settings.json)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
The per-user Claude Code settings file at `~/.claude/settings.json` — model,
theme, output style, permissions, hooks, MCP servers and many other keys that
apply to every project for the current user.

## Claudius today
Fully editable in the browser. The Settings page has a User/Project/Local scope
tab row; the "User" tab reads and writes `~/.claude/settings.json`. The server
side resolves the path in `lib/server/settings.ts` (`pathFor("user", …)`), and
the page renders curated fields (Model & UI, Memory, Chat), a data-driven SDK
catalog, an Environment editor, a generic "Other" editor for unknown keys, and a
Raw JSON mode.

## Decision
ALREADY_EXISTS. Covered by `app/settings/page.tsx` (User scope tab) backed by
`app/api/settings/route.ts` + `app/api/settings/full/route.ts` and
`lib/server/settings.ts`. No new surface needed.
