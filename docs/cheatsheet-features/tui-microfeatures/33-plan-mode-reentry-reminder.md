# Plan-mode re-entry reminder

**Source:** Claude Code TUI — permission flow (plan-mode prompt injection)
**Status:** MISSING

## What it is
When the user re-enters plan mode and a plan file from a previous planning session still exists on disk, the CLI injects a `## Re-entering Plan Mode` reminder pointing at `${H.planFilePath}` and instructs Claude to treat this as a fresh planning session rather than assume the existing plan still applies. The verbatim header is:

> `## Re-entering Plan Mode`
> `You are returning to plan mode after having previously exited it. A plan file exists at ${H.planFilePath} from your previous planning session.`

## Claudius today
Plan mode itself is surfaced — `components/chat/PlanModeBanner.tsx` renders the in-session badge, `components/overlays/PlanOverlay.tsx` handles `ExitPlanMode`, `lib/shared/slash-commands.ts` registers `/plan`, and `lib/shared/session-defaults.ts` carries `planModeInstructions` into `lib/server/session.ts`. But Claudius has no notion of a persisted plan file on disk: a repo grep for `planFilePath`, `plan_mode`, or plan-file paths in `lib/` turns up only the `planModeInstructions` setting and unrelated subagent re-entry comments. Plans live entirely in-memory as `PendingPlan` (`lib/client/types.ts`) attached to the `ExitPlanMode` tool call, so there is nothing to remind the model about on a second entry. Not surfaced in Claudius.

## Decision
MISSING. The CLI behavior depends on a plan file being written to disk between planning sessions, which Claudius does not do — plans are tool-input strings reviewed in `PlanOverlay` and discarded once accepted/rejected. Worth adding only if Claudius starts persisting plans (e.g. into the per-project `.claudius.db` or an asset under `lib/server/`); at that point the natural place for the reminder would be a system-prompt append in `lib/server/session.ts` whenever a session transitions back into `plan` mode with a stored prior plan.
