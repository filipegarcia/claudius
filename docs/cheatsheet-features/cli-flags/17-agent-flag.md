# --agent

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--agent <name>` starts the session running as a specific subagent.

## Claudius today
The create-session route (`app/api/sessions/route.ts`) accepts an `agent` field (merged from workspace defaults), and the agents page (`app/[workspaceId]/agents/page.tsx`) lists and defines the agents that can be selected. Per-session agent invocation also flows through `app/api/sessions/[id]/agents/route.ts`.

## Decision
Already covered. Agent selection is wired into session creation and workspace defaults, with the agents page as the definition/list surface. No new UI needed.
