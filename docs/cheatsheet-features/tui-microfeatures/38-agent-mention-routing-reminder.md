# @agent-name mention re-routes the turn

**Source:** Claude Code TUI — input keyword nudge
**Status:** ALREADY_EXISTS

## What it is
When the user types `@agent-<name>` in a prompt, the Claude Code runtime injects a system reminder keyed `agent_mention` that tells Claude the user explicitly wants to invoke that agent and to delegate accordingly — a soft routing affordance distinct from Claude picking the Agent tool autonomously. The grounded binary string is:

> `agent_mention:(H)=>b3([R6({content:`The user has expressed a desire to invoke the agent "${H.agentType}". Please invoke the agent appropriately, passing in the required context to it. `,isMeta:!0})])`

## Claudius today
The composer-side affordance — getting the `@agent-<name>` token into the prompt that reaches the SDK — is fully wired: `components/chat/at-mention.ts` parses the active `@`-token (an `agent-` prefix flips it to agent mode), `components/chat/AtMentionPicker.tsx` lists the session's loaded agents (sourced from `app/api/sessions/[id]/agents/route.ts`), `components/chat/PromptInput.tsx` inserts the selected row as `@agent-<name> ` verbatim, and `tests/unit/at-mention.test.ts` pins the `agent-<name>` token contract so it can't drift from the SDK's directed-delegation syntax. The reminder template itself (`agent_mention` → "The user has expressed a desire to invoke the agent…") lives inside the Claude Code CLI/SDK runtime, not in Claudius — Claudius just makes sure the trigger string reaches it.

## Decision
ALREADY_EXISTS. The user-facing piece (typing/picking `@agent-<name>`) is already a first-class composer affordance via `AtMentionPicker` + `at-mention.ts`, and the reminder injection it triggers is owned by the SDK, so there is nothing for Claudius to implement on its side. No new UI needed.
