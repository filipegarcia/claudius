# Add server — Remote HTTP transport

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Register an MCP server reachable over a remote HTTP endpoint (`type: "http"`, a URL, and optional auth headers). This is the recommended transport for hosted MCP servers.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) has an "Add" form whose Transport dropdown includes `http` (lines 374-384). Choosing it reveals URL and Headers (JSON) inputs and writes an `{ type: "http", url, headers }` config. The config type lives in `lib/server/mcp.ts` (`McpHttpConfig`), the POST handler is `app/api/mcp/route.ts`, and live connection status/tools render per server.

## Decision
Already covered by the AddServerForm `http` transport branch in `app/[workspaceId]/mcp/page.tsx` (form submit at lines 331-341) plus `upsertServer` in `lib/server/mcp.ts` and `POST /api/mcp`. No new surface needed.
