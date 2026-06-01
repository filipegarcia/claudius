# Plan-verify reminder (verify_plan_reminder)

**Source:** Claude Code TUI — system reminder injection (post plan-completion)
**Status:** MISSING

## What it is
After Claude reports plan completion, the harness fires a `verify_plan_reminder` instructing the model to call the verification tool directly — not via the Task tool or a sub-agent — so plan items are checked end-to-end on the same context. The binary string reads:

> `You have completed implementing the plan. Please call the "" tool directly (NOT the \n tool or an agent) to verify that all plan items were completed correctly.`

The intent is to keep verification in the parent context (where the plan's state, tool history, and files are already loaded) rather than handing it off to a fresh subagent that would lose that grounding.

## Claudius today
Not surfaced in Claudius. `ExitPlanMode` is fully wired — `lib/server/session.ts` captures the plan on the `ExitPlanMode` branch, surfaces it via `components/overlays/PlanOverlay.tsx` for accept/reject, and on accept flips the session out of plan mode through the SDK's `PermissionResult.updatedInput` channel — but the lifecycle ends there. There is no follow-up reminder once the agent finishes executing the plan: grepping `verify_plan`, `verify_plan_reminder`, `completed implementing`, and `verification` in `lib/`, `components/`, and `app/` returns zero hits, and `lib/shared/slash-commands.ts` / `lib/shared/tips.ts` carry no equivalent nudge. The natural home would be the same SSE-reminder pipeline used for other system reminders in `lib/server/session.ts`, fired when the agent reports plan completion after an accepted `ExitPlanMode`.

## Decision
MISSING. Claudius covers the plan-approval half of the loop (`PlanOverlay` + `ExitPlanMode` handler) but not the post-execution verification nudge. Worth adding as a session-scoped reminder in `lib/server/session.ts` that tracks "plan was accepted and is now reported complete" and injects the `verify_plan_reminder` text so the agent runs verification inline rather than spawning a sub-agent.
