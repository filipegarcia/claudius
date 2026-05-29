# Agent frontmatter — initialPrompt

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
An agent's `initialPrompt` frontmatter auto-submits a first turn when the agent starts, so it begins working immediately without a user message.

## Claudius today
The Agents page (`app/[workspaceId]/agents/page.tsx`) does NOT special-case `initialPrompt` — it's absent from both the new-agent `TEMPLATE`'s documented advanced fields and the list-row meta badges (which cover effort/background/memory/maxTurns/permissionMode/skills/mcpServers). The field round-trips through the textarea and is parsed by `lib/server/agents.ts`, but it's invisible in the list view.

## Decision
ALREADY_EXISTS. An `initialPrompt:` line is already authorable and persisted via the agent editor on `app/[workspaceId]/agents/page.tsx` (parsed by `lib/server/agents.ts`) — the editor is the working browser surface; no capability is missing. Optional polish (not a new surface): an "auto-start" indicator badge on the list row, matching how the other advanced fields are badged.
