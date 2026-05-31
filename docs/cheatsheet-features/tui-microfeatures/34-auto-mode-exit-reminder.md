# Auto-mode exit reminder

**Source:** Claude Code TUI — permission flow (mode-transition system reminder)
**Status:** MISSING

## What it is
When the user Shift+Tabs out of auto-accept (auto) mode, the CLI injects a system reminder into the conversation so Claude shifts back to a more interactive posture:

> `## Exited Auto Mode`
> `You have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.`

The handler lives next to a sibling `plan_mode_exit` reminder, so both mode-exit transitions get a matching nudge.

## Claudius today
Not surfaced in Claudius. `components/chat/ModeSelector.tsx` exposes the full permission cycle (including `auto`, with the "Shift+Tab cycles" hint) and calls back into `lib/server/session.ts` `setPermissionMode()` (lines 1562-1569), which flips `this.permissionMode`, forwards to `query.setPermissionMode(mode)`, and broadcasts a `mode_changed` SSE event — but it never inspects the *previous* mode and never injects a system/user reminder when leaving auto. Grepping for `Exited Auto`, `auto_mode_exit`, `prevMode`, or any "clarifying questions" string in `lib/` returns zero hits. The natural home would be `setPermissionMode` in `lib/server/session.ts`, comparing old vs new mode and appending a reminder block to the next user turn (or via the SDK's system-reminder channel) when transitioning `auto -> *`.

## Decision
MISSING. Claudius wires the permission-mode cycle end-to-end but does not replicate the CLI's mode-exit reminders. Worth adding as a small diff in `lib/server/session.ts` `setPermissionMode()` that, on `auto -> non-auto` (and symmetrically `plan -> non-plan`), queues a `## Exited Auto Mode` reminder so the agent loosens its assumption-making after the user pulls back from auto-accept.
