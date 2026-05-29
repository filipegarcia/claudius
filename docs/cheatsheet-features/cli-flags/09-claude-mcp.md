# claude mcp

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude mcp` manages Model Context Protocol server configuration (add/list/remove servers, scopes).

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) lists configured servers per scope (user / project / local), shows live connection-state badges (connected, failed, needs-auth, pending, disabled), and lets you add/edit/remove/enable servers. Backed by `lib/server/mcp.ts` and `app/api/mcp/...`.

## Decision
Already covered. The MCP page is a full browser equivalent of `claude mcp`, including stdio/SSE server config, env-var expansion, and per-tool listing. No new UI needed.
