# Scope: user (global)

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Add an MCP server in the "user" (global) scope so it is available across all of your projects.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) Add form Scope dropdown includes `user (settings.json)` (line 370), labelled `User (~/.claude)` in the list (line 21). `lib/server/mcp.ts` reads from both the user `settings.json` `mcpServers` and `~/.claude/mcp.json` (`userMcpJsonPath`), and `upsertServer`/`removeServer` write user-scope servers to the user `settings.json`.

## Decision
Already covered by the `user` scope option in the AddServerForm and the user-scope branches of `lib/server/mcp.ts`. No new surface needed.
