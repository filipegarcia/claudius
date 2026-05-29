# /hooks

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/hooks` views and manages lifecycle hooks (PreToolUse, PostToolUse, Stop, etc.)
that run shell commands at defined points in the agent loop.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`tools`, "View hook configurations"). The native dispatcher in
`app/[workspaceId]/page.tsx` routes to `app/[workspaceId]/hooks/page.tsx`, a
SideNav tile backed by the `app/api/hooks` route group (and `lib/server/hooks`).

## Decision
ALREADY_EXISTS. Covered by the `/hooks` SideNav tile
(`app/[workspaceId]/hooks/page.tsx`) plus the `app/api/hooks` backend. No new
surface needed.
