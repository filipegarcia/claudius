# /loop — recurring scheduled task

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill that runs a prompt or slash command on a recurring interval (e.g. `/loop 5m /foo`), or self-paced when no interval is given.

## Claudius today
`/loop` is a registered slash command (`lib/shared/slash-commands.ts`, `id: "loop"`, category `skill`, argsHint `[interval] [prompt]`). Beyond invocation, the running loops have a dedicated browser surface: the Schedule page (`app/[workspaceId]/schedule/page.tsx`) lists session-scoped loops via `app/api/schedule/session-loops/route.ts` and can cancel them via `app/api/schedule/session-loops/cancel/route.ts`. Loops armed by the agent's `CronCreate`/wake-up tools are tracked across sessions and shown live (5s poll).

## Decision
ALREADY_EXISTS. Invocation lives in the slash-command picker; lifecycle/observability lives on the Schedule page (`app/[workspaceId]/schedule/page.tsx`) with backing routes under `app/api/schedule/session-loops/`. Both the "start" and "manage" halves of the feature have browser surfaces.
