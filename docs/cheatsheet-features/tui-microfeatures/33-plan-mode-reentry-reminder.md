# Plan-mode re-entry reminder

**Source:** Claude Code TUI — permission flow (plan-mode prompt injection)
**Status:** ALREADY_EXISTS

## What it is
When the user re-enters plan mode after a prior planning round, the CLI injects a `## Re-entering Plan Mode` reminder pointing at `${H.planFilePath}` and instructs Claude to treat this as a fresh planning session rather than assume the existing plan still applies. The verbatim header is:

> `## Re-entering Plan Mode`
> `You are returning to plan mode after having previously exited it. A plan file exists at ${H.planFilePath} from your previous planning session.`

## Claudius today
Implemented end-to-end in `lib/server/session.ts`. The pure helper `planModeReentryReminderBody(priorPlan)` (lines 266-274) emits the CLI's verbatim `## Re-entering Plan Mode` header plus the "You are returning to plan mode after having previously exited it" sentence; because Claudius has no on-disk plan file (`H.planFilePath`), the second sentence is adapted to inline the prior plan text instead. `resolvePlan` persists the resolved plan via `mergeSessionState(this.cwd, this.id, { priorPlan: pending.plan })` (line 1875), and `setPermissionMode` gates on the `wasPlan -> plan` transition (lines 2362-2370) to read `priorPlan` back out of `getSessionState` and `queueReminder(this, "plan-mode-reentry", …)`. Prose is pinned by `tests/unit/plan-mode-reentry-reminder.test.ts`. Plan mode itself is still surfaced through `components/chat/PlanModeBanner.tsx`, `components/overlays/PlanOverlay.tsx`, the `/plan` entry in `lib/shared/slash-commands.ts`, and `planModeInstructions` in `lib/shared/session-defaults.ts`.

## Decision
ALREADY_EXISTS. Claudius mirrors the CLI's behavior with a small adaptation — the prior plan is persisted in the per-session JSON state bag instead of an on-disk plan file, and the second sentence inlines that plan rather than referencing `${H.planFilePath}`. Transition gating in `setPermissionMode` prevents redundant re-fires, the reminder survives resume (matching the CLI's on-disk semantics), and the verbatim header is locked in by a unit test. No follow-up needed.
