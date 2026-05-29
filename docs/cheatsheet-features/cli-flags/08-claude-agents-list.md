# claude agents (list)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude agents` lists the available subagents (file-based, plugin-injected, and built-in).

## Claudius today
The agents page (`app/[workspaceId]/agents/page.tsx`) lists the live agents the SDK reports via `supportedAgents()` — a superset of the `.claude/agents/*.md` files it also edits — and lets you create/edit/delete agent definitions. Backed by `lib/server/agents.ts` and `app/api/agents/...`.

## Decision
Already covered, and then some: Claudius not only lists agents but provides a full editor for them with the SDK frontmatter schema (tools, model, effort, permissionMode, skills, disallowedTools, mcpServers). No new UI needed.
