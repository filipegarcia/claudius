# Add server — Remote SSE transport

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Register an MCP server over Server-Sent Events (`type: "sse"`, a URL, and optional headers) — the older remote transport, supported alongside HTTP.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) Transport dropdown includes `sse` (line 382). It shares the URL + Headers inputs with the HTTP branch and writes an `{ type: "sse", url, headers }` config (`McpSseConfig` in `lib/server/mcp.ts`).

## Decision
Already covered by the AddServerForm `sse` transport option in `app/[workspaceId]/mcp/page.tsx` plus `lib/server/mcp.ts`. No new surface needed.
