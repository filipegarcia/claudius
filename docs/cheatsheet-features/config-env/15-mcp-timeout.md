# MCP_TIMEOUT

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Sets how long Claude Code waits for an MCP server to start before giving up.

## Claudius today
MCP has a dedicated page (`/mcp`) with connection-state badges and per-server management, and `lib/server/mcp.ts` launches the configured servers. The startup-timeout value itself has no labeled control there, but it can be set via the Settings → Environment editor (`app/settings/page.tsx`) by writing `MCP_TIMEOUT` into the settings.json `env` block, which the SDK reads.

## Decision
ALREADY_EXISTS. MCP server management lives at `/mcp`; the startup-timeout env var is reachable through the generic Environment editor in Settings. A dedicated timeout field on `/mcp` would be a low-value advanced knob with a sensible default — not warranted given the env editor already covers it.
