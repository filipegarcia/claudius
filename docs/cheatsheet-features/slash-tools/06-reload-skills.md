# /reload-skills

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** UI_WORTHY

## What it is
`/reload-skills` re-reads skill definitions from disk into the running session
so edits take effect without restarting the agent — the skills analogue of
`/reload-plugins`.

## Claudius today
There is no `reload-skills` entry in `lib/shared/slash-commands.ts`, no
`/api/skills/reload` route, and no `reloadSkills()` method on the session
(`lib/server/session.ts` only exposes `reloadPlugins()`, which proxies the SDK's
`query.reloadPlugins()`). The Skills page (`app/[workspaceId]/skills/page.tsx`)
re-reads from disk when you open or refresh it, but that only updates the
*editor* — it does not push the new skill set into the live SDK session, so a
skill edited mid-session is not picked up until a new session starts.

Contrast `/reload-plugins`, which is fully wired: registry entry → native
dispatcher in `app/[workspaceId]/page.tsx` (`case "reload-plugins"`) →
`POST /api/plugins/reload?sessionId=...` → `session.reloadPlugins()` →
`query.reloadPlugins()`.

## Decision
UI_WORTHY (deferred — needs backend). Add a "Reload into session" button to the
Skills page header (next to the existing refresh control) and a matching
`reload-skills` registry entry that dispatches like `reload-plugins`. The UI
shell mirrors an existing pattern, but the backend is the blocker: the SDK query
exposes `reloadPlugins()` but no `reloadSkills()`. If the SDK adds a
skills-reload control request, wire `session.reloadSkills()` + a
`POST /api/skills/reload?sessionId=...` route; until then the honest fallback is
a toast that says edits apply on the next session start. Priority: low.
