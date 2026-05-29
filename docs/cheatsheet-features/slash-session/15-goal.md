# /goal

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Sets a completion goal for the session; Claude works toward it and the goal is tracked/shown prominently until met, with live progress.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "goal"`, alias `objective`, handler `native`, `argsHint: "[goal text]"`). `/goal <text>` records the objective via `session.setGoal(...)` AND starts Claude on it; `/goal` with no args opens the inline editor. The `GoalBanner` (`components/chat/GoalBanner.tsx`) renders the no-goal / editing / goal-set / achieved states in the session header. Achievement is driven by the in-process `report_goal_achieved` SDK tool and surfaced via the `goal_changed` SSE event; goal-tagged messages persist via `goal-messages-db` + migration `010_session_goal.sql`/`011_goal_messages.sql`.

## Decision
ALREADY_EXISTS. Fully built out: native dispatcher case `"goal"` in `app/[workspaceId]/page.tsx` (around line 702), `components/chat/GoalBanner.tsx`, the `POST /api/sessions/[id]/goal` and `GET /api/sessions/[id]/goal-messages` routes, the `mcp__claudius_goal__report_goal_achieved` tool wired in `lib/server/session.ts`, and DB migrations. The "live progress overlay" is realized as the celebratory achieved strip plus the running workflow/status in the transcript.
