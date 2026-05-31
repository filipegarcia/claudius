# MCP / agent / deferred-tool delta reminders mid-session

**Source:** Claude Code TUI — observed in session
**Status:** MISSING

## What it is
When MCP servers connect or disconnect, deferred-tool availability shifts, or agent types become available/unavailable, the harness injects targeted delta reminders into Claude's next turn — e.g. `The following deferred tools are now available via ToolSearch ... with query "select:<name>[,<name>...]" to load tool schemas before calling them`, or `deferred tools are no longer available (MCP server disconnected): ...`. The reminder also instructs Claude to `wait for connecting servers and search their tools once available. Do not report a capability as unavailable without first searching.`

## Claudius today
Not surfaced in Claudius. `app/[workspaceId]/mcp/page.tsx` and `lib/client/useMcp.ts` display live MCP connection status (connected / failed / needs-auth / pending / disabled) in a dedicated page, and `lib/server/session.ts` exposes `mcpServerStatus()`, but no code path injects a `<system-reminder>`-style delta into the agent's next turn when servers, agent types, or deferred tools come online or drop. `lib/server/customization-description.ts` only strips inbound `<system-reminder>` blocks from rendered history; it does not author them. A natural home would be a delta-detector in `lib/server/session.ts` that diffs MCP/agent state across turns and prepends a reminder to the next user message.

## Decision
MISSING. Worth adding if the user wants the agent to self-heal when an MCP server reconnects mid-session — a small diff hook in `lib/server/session.ts` could compare the previous and current `mcpServerStatus()` plus agent-type lists and inject the canonical reminder text into the next turn's prompt.
