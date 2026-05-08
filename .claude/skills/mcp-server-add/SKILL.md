---
name: mcp-server-add
description: Register a new Model Context Protocol server in the workspace defaults so Claudius launches it on every session. Covers stdio + SSE servers, env-var expansion, and the connection-state badges shown on /mcp. Use when the user says "wire up X MCP" / "add a server for Y" / "connect Linear/Slack/Postgres".
allowed-tools:
  - Read
  - Edit
  - Bash
  - Grep
---

# Add an MCP server

MCP server config lives in the workspace defaults — managed via `/mcp` in the UI or directly under `lib/server/workspaces-store.ts`. The session manager forwards the merged config to the agent SDK on session start.

## Two transports

- **stdio** — local binary, communicates over pipes. Use for CLI-shaped servers (linear, slack, github via the Anthropic-published binaries). Field shape: `{ command, args, env }`.
- **sse / http** — remote URL. Use when the server is hosted (custom in-house, or a managed MCP). Field shape: `{ url, headers }`.

## Steps

1. Find the server's config snippet — usually in its README or the MCP registry. Note required env vars (API keys, workspace ids).
2. Add it through `/mcp` (preferred — validates on save) or by editing the workspace's `defaults.mcp` block. Use a short, lowercase id (`linear`, `pg`, `slack`).
3. **Don't paste secrets inline.** Use `${ENV_VAR}` placeholders; the session manager expands them at launch.
4. Reload the session. The dot in the `/mcp` row goes green when the handshake completes; red with an error message if not.

## Common gotchas

- The server's `command` must be on the PATH of the dev server's process, not your shell. If `which mcp-foo` works but Claudius can't find it, set the absolute path.
- Some servers require `npx -y` (no-prompt install) on first launch — fine, but bake it into `args`.
- A stuck "Connecting…" usually means the binary is waiting on stdin and never sent its hello. Check the server's stderr in the dev server log.
- Env-var expansion only happens on session START. Changing an env var doesn't affect a running session — restart it.
