# continueOnBlock

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** IMPLEMENTED

**Implemented:** `continueOnBlock?: boolean` added to the `prompt` variant of
`HookHandler` in `lib/shared/hook-events.ts`; a `continueOnBlock` toggle (shown
only for the `prompt` handler type, beside `once`) plus a detail badge in
`app/[workspaceId]/hooks/page.tsx`. Persists verbatim via `lib/server/hooks.ts`
addGroup — round-trip covered by `tests/unit/hooks-continue-on-block.test.ts`.

## What it is
A per-hook flag (`continueOnBlock`) on `prompt` hook steps that controls
the `continue` value of the `decision: "block"` they produce when `ok` is false.
With it on, the turn can keep running after a blocked tool call instead of ending.

## Claudius today
Not surfaced, and not even in Claudius's hook type mirror. The SDK defines
`continueOnBlock?` on the `prompt` hook variant
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), but the `HookHandler`
union in `lib/shared/hook-events.ts` does not include it, so the Hooks page Add
form has no control for it. It can only be set today via the settings Raw JSON
editor, and the dedicated hook editor would silently drop it on a round-trip
through the form.

## Decision
UI_WORTHY (low). Extend the `prompt` variant of `HookHandler` in
`lib/shared/hook-events.ts` with `continueOnBlock?: boolean`, then add a toggle in
`AddHookForm` (shown only for the `prompt` handler type, next to the existing
`once` toggle). The SDK defines `continueOnBlock?` solely on the `prompt` hook
variant (not on `agent`), so it is not added to `agent` — a toggle there would be
a no-op dead control. No server/DB work — `lib/server/hooks.ts` persists the
group as-is. Low priority: it is an advanced verifier-hook knob, currently
reachable via Raw JSON.
