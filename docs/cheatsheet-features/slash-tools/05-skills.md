# /skills

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/skills` lists the skills available to the current session (user- and
project-scoped SKILL.md files).

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`tools`, "List available skills"). The native dispatcher in
`app/[workspaceId]/page.tsx` (`case "skills": setOverlay("skills")`) opens a
skills overlay, and there is also a full Skills page at
`app/[workspaceId]/skills/page.tsx` (a SideNav tile) that browses, edits,
creates, and deletes skills across `user` (~/.claude/skills) and `project`
(.claude/skills) scopes with search. Backed by `app/api/skills` and
`lib/server/skills`.

## Decision
ALREADY_EXISTS. Listing (and full editing) is covered by the `/skills` overlay
and the `app/[workspaceId]/skills/page.tsx` tile. No new surface needed.
