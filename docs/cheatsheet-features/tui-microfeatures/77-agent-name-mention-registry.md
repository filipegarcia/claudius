# Agent-name registry for @-mention routing

**Source:** Claude Code TUI — state-store-buddy
**Status:** ALREADY_EXISTS

## What it is
The TUI's `AppState` keeps a name→AgentId map populated whenever the Agent tool is invoked with a `name` parameter, so a `@<name>` mention or a `SendMessage` call can target a live subagent by its human-friendly handle instead of a UUID. The grounded leak in `src/state/AppStateStore.ts` spells out the contract:

> `// Name → AgentId registry populated by Agent tool when ` + "`name`" + ` is provided.\n  // Latest-wins on collision. Used by SendMessage to route by name.\n  agentNameRegistry: Map<string, AgentId>`

The latest-wins rule means that if two subagents are spawned with the same `name`, the most recent one captures the mention — handy when a "reviewer" agent gets re-spawned mid-turn.

## Claudius today
The composer side of this — getting `@agent-<name>` into the prompt that reaches the SDK — already ships. `components/chat/at-mention.ts` parses the active `@`-token (an `agent-` prefix flips it to agent mode), `components/chat/AtMentionPicker.tsx` lists the session's loaded agents (sourced once-per-session from `app/api/sessions/[id]/agents/route.ts`), and `components/chat/PromptInput.tsx` inserts the selected row as `@agent-<name> ` verbatim so the SDK's directed-delegation parser picks it up — the same flow documented in `38-agent-mention-routing-reminder.md`. The registry itself (the `Map<string, AgentId>` that resolves a name to the right live subagent for `SendMessage` and re-routes a turn when the user types `@reviewer`) lives inside the Claude Code SDK runtime, not in Claudius. On the Claudius side, the agent list endpoint already returns the same `name` field the SDK uses as the registry key, so the picker is naming-by-the-same-key as the SDK's internal map. Subagent activity itself is rendered through `components/chat/TaskBlock.tsx`, with persistent metadata in `lib/server/session-tasks-db.ts` (subagent_type, status, etc.), so once the SDK routes by name the resulting subagent surfaces normally.

## Decision
ALREADY_EXISTS. The user-facing piece (typing/picking `@agent-<name>`, with names matching the SDK's `name` parameter) is wired through `AtMentionPicker` + `at-mention.ts` + `/api/sessions/[id]/agents`, and the `agentNameRegistry` resolution + `SendMessage` routing it backs are owned by the SDK runtime — there is nothing for Claudius to implement on its side. The latest-wins-on-collision behavior cited in `src/state/AppStateStore.ts` is purely an SDK concern; Claudius just feeds the picker from the same agent list the SDK builds the map from, so the two stay in sync without extra plumbing.
