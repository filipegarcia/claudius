# Linter-modified-file reminder

**Source:** Claude Code TUI — hooks
**Status:** MISSING

## What it is
If a formatter or linter touches a file Claude just wrote, the next turn carries a system reminder telling Claude the change `was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware.` A budget-aware variant omits the diff: `The diff was omitted because other modified files in this turn already exceeded the snippet budget; use the Read tool if you need the current content.`

## Claudius today
Not surfaced in Claudius. It would naturally ride the existing `PostToolUse` hook pipeline in `lib/shared/hook-events.ts` / `app/[workspaceId]/hooks/page.tsx`, where a post-Edit/Write hook could detect a linter-touched file and inject the same reminder into the next turn.

## Decision
MISSING. The reminder is an agent-internal nudge to the model (the user is explicitly not told), so there is no UI to render — but Claudius could replicate the behavior with a built-in `PostToolUse` hook on `Edit|Write` that diffs the on-disk file against what Claude wrote and prepends the same reminder text. Worth adding only if users report Claude reverting linter/formatter fixes in the next turn.
