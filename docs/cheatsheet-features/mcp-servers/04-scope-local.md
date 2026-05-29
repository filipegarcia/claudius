# Scope: local (~/.claude.json)

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
Add an MCP server in the "local" (personal, per-machine, not version-controlled) scope. In the CLI this is the default scope.

## Claudius today
The MCP page (`app/[workspaceId]/mcp/page.tsx`) Add form has a Scope dropdown with a `local` option (line 371), and the scope is shown per server via `SCOPE_LABELS` (line 22). `lib/server/mcp.ts` persists local servers to `settings.local.json` under `mcpServers` (`listConfigured`/`upsertServer`/`removeServer`). Note the storage path differs from the cheat sheet (`settings.local.json` rather than `~/.claude.json`), but the local-scope surface itself is present and writable.

## Decision
Already covered by the `local` option in the AddServerForm scope select and the `scope === "local"` branches in `lib/server/mcp.ts`. The path-mapping difference is an implementation detail, not a missing surface. No new surface needed.
