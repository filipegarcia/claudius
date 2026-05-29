# Scope: project (.mcp.json)

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Add an MCP server in the "project" scope, stored in a version-controlled `.mcp.json` at the project root so the whole team shares it.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) Add form defaults the Scope dropdown to `project (.mcp.json)` (line 289, 369). `lib/server/mcp.ts` reads/writes the project `.mcp.json` via `projectMcpJsonPath` and the `scope === "project"` branches of `listConfigured`/`upsertServer`/`removeServer`.

## Decision
Already covered by the `project` scope option in the AddServerForm and the `.mcp.json` read/write logic in `lib/server/mcp.ts`. No new surface needed.
