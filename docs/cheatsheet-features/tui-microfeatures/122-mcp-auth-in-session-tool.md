# McpAuth — In-Session MCP OAuth Flow Tool

**Source:** Claude Code TUI — tools
**Status:** MISSING

## What it is
A pseudo-tool the harness injects for an installed-but-unauthenticated MCP server: instead of advertising the server's real (still-unloaded) tools, it advertises a single `McpAuth` entry whose comment in `tools/McpAuthTool/McpAuthTool.ts` reads "Creates a pseudo-tool for an MCP server that is installed but not authenticated. Surfaced in place of the server's real tools so the model knows the server exists and can start the OAuth flow on the user's behalf." Calling it runs `performMCPOAuthFlow`, returns an authorization URL for the user to open, and — once OAuth completes — the server reconnects and its real `mcp__<server>__<tool>` entries swap in transparently.

## Claudius today
Not surfaced in Claudius. The `needs-auth` connection state is already plumbed (`lib/client/useMcp.ts` line 10, `app/[workspaceId]/mcp/page.tsx` line 15 paints it amber), but it only ever appears as a status badge on the `/mcp` page — there is no pseudo-tool exposed to the model, no in-session prompt that would let the agent itself initiate the OAuth flow, and no equivalent of `performMCPOAuthFlow`. The natural location would be a system-reminder + ephemeral tool injected by `lib/server/session.ts` whenever `mcpServerStatus()` reports a server in `needs-auth`, alongside the existing `reconnectMcp` / `setMcpServers` plumbing (lines 3056-3115).

## Decision
MISSING. Claudius surfaces the `needs-auth` state visually on `/mcp` but never lets the model help unblock it; the leak (`tools/McpAuthTool/McpAuthTool.ts`, 7 binary hits) shows Claude Code injects a fake tool so the agent can hand the user an authorization URL mid-turn. To match, Claudius would need a server-side hook that detects `needs-auth` from `Session.mcpServerStatus()`, registers an in-process pseudo-tool via `createSdkMcpServer` that resolves to an OAuth URL (the SDK exposes the remote-OAuth path per `docs/explorations/native-harness-feasibility.md` line 95), and a system-reminder that nudges the model to call it instead of attempting `mcp__<server>__*` tools that are not yet loaded.
