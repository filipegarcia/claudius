# continueOnBlock

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** UI_WORTHY

## What it is
A per-hook flag (`continueOnBlock`) on `prompt`/`agent` hook steps that controls
the `continue` value of the `decision: "block"` they produce when `ok` is false.
With it on, the turn can keep running after a blocked tool call instead of ending.

## Claudius today
Not surfaced, and not even in Claudius's hook type mirror. The SDK defines
`continueOnBlock?` on the prompt/agent hook variants
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), but the `HookHandler`
union in `lib/shared/hook-events.ts` does not include it, so the Hooks page Add
form has no control for it. It can only be set today via the settings Raw JSON
editor, and the dedicated hook editor would silently drop it on a round-trip
through the form.

## Decision
UI_WORTHY (low). Extend the `prompt`/`agent` variants of `HookHandler` in
`lib/shared/hook-events.ts` with `continueOnBlock?: boolean`, then add a toggle in
`AddHookForm` (shown for prompt/agent handler types, next to the existing `once`
toggle). No server/DB work — `lib/server/hooks.ts` persists the group as-is. Low
priority: it is an advanced verifier-hook knob, currently reachable via Raw JSON.
