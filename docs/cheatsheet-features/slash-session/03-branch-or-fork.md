# /branch or /fork

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Branches (forks) the current conversation into a new session at the latest message, optionally with a name.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "fork"`, alias `branch`, handler `native`, `argsHint: "[name]"`). The native dispatcher POSTs to `/api/sessions/fork` with the current `sessionId` and the optional title argument, then navigates to the new session.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"fork"`, around line 666) and the `POST /api/sessions/fork` route. Forking is also reachable from the session UI; the `[name]` argument maps to the route's `title` field.
