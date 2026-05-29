# Hook step invokes MCP tool (type: mcp_tool)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
A hook step of `type: "mcp_tool"` that, when the event fires, invokes a named MCP
tool (e.g. `mcp__server__notify`) with optional JSON arguments — letting hooks
call into MCP servers.

## Claudius today
Fully supported in the Hooks editor. `HookHandler` in `lib/shared/hook-events.ts`
includes the `{ type: "mcp_tool"; tool; arguments?; once? }` variant, and
`AddHookForm` in `app/[workspaceId]/hooks/page.tsx` offers "mcp_tool" as a handler
type with a tool-name input and an Arguments (JSON) editor. `EventRow` renders the
tool name for existing mcp_tool steps; `lib/server/hooks.ts` persists it.

## Decision
ALREADY_EXISTS. Covered by `app/[workspaceId]/hooks/page.tsx` (Add Hook →
handler type "mcp_tool"). No new surface needed.
