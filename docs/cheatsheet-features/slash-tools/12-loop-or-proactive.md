# /loop or /proactive

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/loop` (a.k.a. `/proactive`) runs a prompt or slash command on a recurring
interval (e.g. `/loop 5m /foo`); omitting the interval lets the model self-pace.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`skill`, argsHint `[interval] [prompt]`). The native dispatcher in
`app/[workspaceId]/page.tsx` (`case "loop": case "schedule": router.push("/schedule")`)
opens the Schedule page at `app/[workspaceId]/schedule/page.tsx` (a SideNav
tile). That page manages recurring routines / session-loops and is backed by the
`app/api/schedule` route group (`+ session-loops`, `+ run-now`, `+ runs`). The
session itself also tracks loop arming/timing in `lib/server/session.ts` (the
loop timer that survives reload). The `loop` skill documents interval syntax.

## Decision
ALREADY_EXISTS. Covered by the `/loop` (and `/schedule`) native dispatch into the
Schedule SideNav tile (`app/[workspaceId]/schedule/page.tsx`) plus the
`app/api/schedule` + session-loops backend. No new surface needed.
