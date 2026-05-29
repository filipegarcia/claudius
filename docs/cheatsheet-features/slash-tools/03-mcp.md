# /mcp

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/mcp` manages Model Context Protocol servers — add/remove servers, view
connection state, and handle OAuth for hosted MCP servers.

## Claudius today
Registered in `lib/shared/slash-commands.ts` as `handler: "native"` (category
`tools`). The native dispatcher in `app/[workspaceId]/page.tsx` routes to the
MCP page at `app/[workspaceId]/mcp/page.tsx` (a SideNav tile). The page is
backed by the `app/api/mcp` route group and shows per-server connection-state
badges; the `mcp-server-add` skill documents adding stdio/SSE servers with
env-var expansion. Workspace defaults persist server selection via
`lib/server/workspaces-store.ts` (`mcpServerIds`).

## Decision
ALREADY_EXISTS. Covered by the `/mcp` SideNav tile (`app/[workspaceId]/mcp/page.tsx`)
plus the `app/api/mcp` backend. No new surface needed.
