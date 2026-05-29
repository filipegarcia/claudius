# Interactive UI management (/mcp)

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
The CLI's `/mcp` interactive view for managing MCP servers — listing them, seeing connection state, and authenticating/reconnecting/disabling.

## Claudius today
This is one of the most complete surfaces in the app. `app/[workspaceId]/mcp/page.tsx` is a full MCP management page (in the SideNav as "MCP") that lists configured + live servers, shows per-server transport, scope, connection status badge (connected/failed/needs-auth/pending/disabled), serverInfo, error, raw config, and exposed tools. It supports Add, Reconnect, Enable/Disable (toggle), and Delete. Backed by `lib/client/useMcp.ts`, `app/api/mcp/route.ts`, `app/api/mcp/[name]/{route,toggle,reconnect}/route.ts`, and `session.mcpServerStatus/reconnectMcp/toggleMcp` in `lib/server/session.ts`. The bare `/mcp` path (`app/mcp/page.tsx`) redirects to the workspace-scoped page.

## Decision
Already covered, comprehensively, by the `app/[workspaceId]/mcp/page.tsx` page and its API/session plumbing. No new surface needed.
