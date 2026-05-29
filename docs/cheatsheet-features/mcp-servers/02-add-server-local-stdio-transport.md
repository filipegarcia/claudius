# Add server — Local stdio transport

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Register an MCP server that runs as a local child process and communicates over stdio (`command`, `args`, `env`). This is the classic local transport.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) defaults the Transport dropdown to `stdio` and shows Command, Args (space-separated), and Env (JSON object) inputs (lines 394-421). It writes an `{ type: "stdio", command, args, env }` config via `upsertServer` (`lib/server/mcp.ts`, `McpStdioConfig`) and `POST /api/mcp`.

## Decision
Already covered by the AddServerForm `stdio` branch in `app/[workspaceId]/mcp/page.tsx` and `lib/server/mcp.ts`. No new surface needed.
