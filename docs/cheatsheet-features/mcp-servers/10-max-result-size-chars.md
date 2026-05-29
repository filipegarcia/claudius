# maxResultSizeChars up to 500K

**Source:** Claude Code cheat sheet — MCP Servers
**Status:** UI_WORTHY

## What it is
A threshold (cheat sheet says raisable up to 500K) controlling the maximum size of an MCP tool's text result before it is truncated/handled specially — raising it lets large tool outputs through.

## Claudius today
There is no surface for this and, importantly, no SDK-typed config key to write to. Grepping the codebase finds `maxResultSizeChars` only in `scripts/triage-workflow.mjs` (this triage's own feature list), not in app/lib code. In the installed SDK, the per-server MCP config types (`McpStdioServerConfig`, `McpSSEServerConfig`, `McpHttpServerConfig` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) declare only `command/args/env`/`url/headers`, `timeout`, `alwaysLoad`, and `tools` — there is no `maxResultSizeChars` field. The string appears only baked into the compiled `claude` binary, implying it is read at a CLI/tool layer, not accepted on the per-server config the SDK (and Claudius via `lib/server/mcp.ts`) writes.

## Decision
UI_WORTHY — deferred, needs backend. The natural home would be a numeric "Max result size (chars)" field in the AddServerForm on `app/[workspaceId]/mcp/page.tsx`, extending `McpServerConfig` in `lib/server/mcp.ts`. But that is only a UI shell: the SDK's typed MCP config path does not expose `maxResultSizeChars`, so a field written to `.mcp.json`/settings would not be honored along the route Claudius uses. Building it requires first establishing how the SDK consumes this knob (per-server config key, a global option/env var on the `query`, or a CLI-only setting) and wiring that through `lib/server/session.ts`. Until that plumbing is confirmed, do not ship a field that writes a key nothing reads. Low priority.
