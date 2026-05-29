# Conditional hooks (hooks: if)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** IMPLEMENTED

**Implemented:** Per-handler `if?: string` added to all five `HookHandler` variants in
`lib/shared/hook-events.ts` (the dead group-level `if` was removed — the SDK never read it).
`AddHookForm` in `app/[workspaceId]/hooks/page.tsx` gained an "If (rule filter)" input that
spreads `if` into every handler shape, and `EventRow` renders the `if=…` badge per handler.

## What it is
An `if` field on a hook *handler* that gates whether the hook runs using
permission-rule syntax (e.g. `"Bash(git *)"`). The hook only fires when the tool
call matches the pattern — avoids spawning hooks for non-matching commands. Per the
bundled SDK schema (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), `if`
lives on each handler variant (command/http/prompt/agent/mcp_tool), **not** on the
hook group — the group object is exactly `{ matcher?, hooks }`.

## Claudius today
Implemented. `lib/shared/hook-events.ts` carries `if?: string` on all five
`HookHandler` variants, and `lib/server/hooks.ts` / the `/api/hooks` route pass
handler objects through verbatim, so an `if` round-trips with no server change.
The Hooks page Add form (`app/[workspaceId]/hooks/page.tsx`, `AddHookForm`) has an
"If (rule filter)" input that spreads `if` into every handler shape, and `EventRow`
renders the `if=…` value per handler.

## Decision
IMPLEMENTED (med). Added a per-handler "If (rule filter)" text input to
`AddHookForm` (spread into each handler when non-empty), and show the `if` value in
`EventRow` per handler. Removed the dead group-level `if?: string` that the SDK
never reads. No backend change — `lib/server/hooks.ts` and the API already pass the
field through.
