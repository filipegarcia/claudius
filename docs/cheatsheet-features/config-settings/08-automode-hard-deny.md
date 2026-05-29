# autoMode.hard_deny

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** NOT_APPLICABLE

## What it is
An `autoMode.hard_deny` rule set — unconditional deny rules that auto-mode must
never override (a hard floor on what the automatic permission mode is allowed to
approve).

## Claudius today
No surface, because the key does not exist in the bundled SDK. A search of
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` finds no `hard_deny` or
`autoMode` object at all — only a flat `disableAutoMode?: 'disable'` toggle (a
different, simpler key, reachable via the generic Other editor). The permission
deny list (`permissions.deny`) is already editable via the `/permissions` page
and the settings Permissions surface, but that is not the same construct.

## Decision
NOT_APPLICABLE (deferred — not in current SDK). There is nothing in the
installed SDK's settings schema to bind a UI to. Revisit if a future SDK adds an
`autoMode.hard_deny` shape; until then there is no buildable surface.
