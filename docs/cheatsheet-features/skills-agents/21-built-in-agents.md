# Built-in agents (Explore/Plan/General/Bash)

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
Claude Code ships built-in subagent types (Explore, Plan, General-purpose, Bash) that the main agent can delegate to via the Task/Agent tool.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) shows a "SDK reports N agents loaded for this session" banner fed by `app/api/sessions/[id]/agents/route.ts` (which calls the SDK's `supportedAgents()`) — this is the live superset that includes built-in agents, not just the `.claude/agents/*.md` files. At runtime, delegations to any subagent (built-in or file-based) render through `components/chat/TaskBlock.tsx` (subagent name resolved via `lib/shared/subagent-tool.ts`, which matches both the legacy `Task` and current `Agent` tool names), with inner messages, token counts, and status.

## Decision
ALREADY_EXISTS. Discovery is in the Agents page loaded-agents banner (`app/[workspaceId]/agents/page.tsx` + `app/api/sessions/[id]/agents/route.ts`); runtime invocation is visualized by `components/chat/TaskBlock.tsx`.
