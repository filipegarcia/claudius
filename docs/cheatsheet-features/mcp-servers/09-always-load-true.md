# alwaysLoad: true

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** ALREADY_EXISTS

## What it is
A per-server config flag. When `alwaysLoad: true`, all of the server's tools are included in the prompt at startup and never deferred behind tool search (equivalent to `defer_loading: false`), at the cost of blocking startup until the server connects.

## Claudius today
The MCP Add form (`app/[workspaceId]/mcp/page.tsx`) has an `alwaysLoad` checkbox with an explanatory label (lines 443-454); it is written into the config on submit for both stdio and remote transports (lines 329, 339). The flag is declared on every config type in `lib/server/mcp.ts` (`McpStdioConfig`/`McpHttpConfig`/`McpSseConfig`) and matches the SDK's `alwaysLoad?: boolean` on `McpStdioServerConfig`/`McpSSEServerConfig`/`McpHttpServerConfig` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), so it is a real, SDK-backed field.

## Decision
Already covered by the `alwaysLoad` checkbox in the AddServerForm plus the typed config in `lib/server/mcp.ts`. It is editable only at add time today (no inline edit per row), which is acceptable; no new surface needed.
