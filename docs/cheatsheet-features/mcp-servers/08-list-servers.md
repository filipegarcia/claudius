# List servers (claude mcp list)

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
The CLI command `claude mcp list` enumerates configured MCP servers (with their scope and transport).

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) renders exactly this: it merges configured servers (from all scopes via `listConfigured`) with live status into a sorted list, showing name, transport, scope, status, and tool count per row (the `merged` memo at lines 58-73 and `ServerRow`). The data comes from `GET /api/mcp` (`app/api/mcp/route.ts`) via `lib/client/useMcp.ts`.

## Decision
Already covered by the server list on `app/[workspaceId]/mcp/page.tsx` and `GET /api/mcp`. This is the browser equivalent of `claude mcp list`. No new surface needed.
