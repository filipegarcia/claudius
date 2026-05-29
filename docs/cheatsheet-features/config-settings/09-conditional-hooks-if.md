# Conditional hooks (hooks: if)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** UI_WORTHY

## What it is
An `if` field on a hook (group or handler) that gates whether the hook runs using
permission-rule syntax (e.g. `"Bash(git *)"`). The hook only fires when the tool
call matches the pattern — avoids spawning hooks for non-matching commands.

## Claudius today
Partially present. The data model already supports it: `HookGroup` in
`lib/shared/hook-events.ts` carries `if?: string`, and `lib/server/hooks.ts`
persists whatever group object it is handed — so an `if` written via the settings
Raw JSON editor round-trips correctly. But the Hooks page Add form
(`app/[workspaceId]/hooks/page.tsx`, `AddHookForm`) has **no `if` input**, and
`EventRow` does not render an existing `if` value. So you cannot create or even
see a conditional hook from the dedicated Hooks UI.

## Decision
UI_WORTHY (med). Add an "If (permission-rule filter)" text input to `AddHookForm`
(included in the persisted `HookGroup` when non-empty), and show the `if` value in
`EventRow` alongside the matcher. No backend change — `lib/server/hooks.ts` and
the API already accept the field. Medium priority because conditional hooks are a
real, commonly used hook feature that the dedicated editor currently hides.
