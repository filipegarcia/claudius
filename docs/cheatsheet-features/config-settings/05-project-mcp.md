# Project MCP (.mcp.json)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
`.mcp.json` at the project root declares the project's Model Context Protocol
servers (stdio / http / sse), shared with the team via the repo.

## Claudius today
First-class browser surface. `lib/server/mcp.ts` reads and writes `.mcp.json`
(`projectMcpJsonPath`) for the "project" scope and mirrors user/local servers in
the settings files; the `/mcp` page (`app/[workspaceId]/mcp/page.tsx`) lists,
adds, edits and removes servers per scope with connection-state badges. The
`mcp-server-add` skill scaffolds new entries.

## Decision
ALREADY_EXISTS. Covered by `app/[workspaceId]/mcp/page.tsx` backed by
`lib/server/mcp.ts` (`listConfigured` / `upsertServer` / `removeServer`). No new
surface needed.
