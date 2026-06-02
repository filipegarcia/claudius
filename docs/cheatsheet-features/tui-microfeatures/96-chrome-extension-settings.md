# /chrome — Claude in Chrome (Beta) Settings

**Source:** Claude Code TUI — commands
**Status:** MISSING

## What it is
`/chrome` opens a settings menu (binary string count 69) for the Claude-in-Chrome MCP integration — install the Chrome extension, manage per-site permissions, reconnect a disconnected extension, and toggle "enabled by default". The pitch sits in `commands/chrome/chrome.tsx`: "Claude in Chrome works with the Chrome extension to let you control your browser directly from Claude Code. Navigate websites, fill forms, capture screenshots, record GIFs, and debug with console logs and network requests." It is gated to claude-ai subscribers running an interactive session.

## Claudius today
Not surfaced in Claudius. `lib/shared/slash-commands.ts` line 136 has a stub entry — `{ id: "chrome", name: "chrome", description: "Configure Chrome integration.", category: "integrations", handler: "external" }` — so the slash picker advertises it, but the `external` handler means typing `/chrome` does nothing inside the web app and there is no corresponding settings page, MCP server registration, or extension handshake (`components/chrome/` is unrelated — it hosts the Electron TitleBar and web→desktop banner). The natural home for a Claudius equivalent would be a Tools-style page under `app/[workspaceId]/` mirroring `/mcp`, sharing the MCP connection-state pattern from `lib/server/mcp/` since the TUI feature is itself an MCP bridge to the extension.

## Decision
MISSING. The TUI screen documented by `commands/chrome/chrome.tsx` (binary grep 69) has no analog in Claudius beyond the `external` slash-command stub in `lib/shared/slash-commands.ts:136`. Browser-control-from-Claude only makes sense in the Electron build (the web Claudius already runs *in* a browser tab) — a faithful port would register a Claude-in-Chrome MCP server alongside the existing defaults and expose install/permission/reconnect controls on a `/chrome` settings route, with the slash command flipped from `external` to `native` once the page lands.
