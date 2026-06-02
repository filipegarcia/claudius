# ListMcpResources / ReadMcpResource Tools

**Source:** Claude Code TUI — tools
**Status:** MISSING

## What it is
Two SDK-level tools let the agent treat MCP servers as resource directories rather than just tool callers: `ListMcpResources` enumerates resources across configured MCP servers (filterable by server, each entry carrying `uri` / `name` / `mimeType` / `description` plus a `server` field), and `ReadMcpResource` fetches a specific resource's contents by URI. The leaked tool prompt at `tools/ListMcpResourcesTool/ListMcpResourcesTool.ts` spells the contract out: "Lists available resources from configured MCP servers. Each resource object includes a 'server' field indicating which server it's from. Usage examples: - List all resources from all servers: `listMcpResources` - List resources from a specific server: `listMcpResources({ server: \"myserver\" })`".

## Claudius today
Not surfaced in Claudius. The MCP plumbing in `lib/server/mcp.ts` (`listConfigured`, `upsertServer`, `removeServer`) and the `/mcp` page at `app/[workspaceId]/mcp/page.tsx` only manage *server configuration* — scope, command/url, headers, alwaysLoad, plus the connection-status badges (`pending` / `connected` / `failed` / `needs-auth` / `disabled`) from `lib/client/useMcp.ts`. There is no `resources/list` or `resources/read` call site anywhere in `lib/`, `app/`, or `components/`, and the agent is not given a counterpart tool — the SDK's MCP integration in Claudius is tools-only. The natural home would be a "Resources" tab on `app/[workspaceId]/mcp/page.tsx` backed by a new `app/api/mcp/[name]/resources/route.ts` that proxies `resources/list` and a sibling `resources/read` endpoint, with a server-side helper in `lib/server/mcp.ts`.

## Decision
MISSING. The two tools live entirely inside Claude Code's tool registry per the leak at `tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`, and Claudius does not pass through any MCP capability beyond tool calls — `lib/server/mcp.ts` and the `/mcp` UI know about servers and tools but never enumerate or fetch resources. Wiring this up is two pieces: (1) expose `resources/list` / `resources/read` on the SDK MCP client and surface them as a Resources panel on `app/[workspaceId]/mcp/page.tsx`, and (2) — if/when the Agent SDK exposes these as agent-callable tools — allow-list them through the permissions flow alongside the existing `mcp__*` tool names.
