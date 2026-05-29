# /agents

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/agents` manages subagent configurations — the named agent definitions
(frontmatter + prompt) the main agent can dispatch work to.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`tools`, "Manage subagent configurations"). The native dispatcher in
`app/[workspaceId]/page.tsx` (`case "agents": router.push("/agents")`) opens the
Agents page at `app/[workspaceId]/agents/page.tsx` (a SideNav tile). The page
edits agent frontmatter (model, tools, background, memory, permissionMode,
skills, disallowedTools, mcpServers) and is backed by `app/api/agents` and
`lib/server/agents.ts`.

## Decision
ALREADY_EXISTS. Covered by the `/agents` SideNav tile
(`app/[workspaceId]/agents/page.tsx`) plus the `app/api/agents` backend. No new
surface needed.
