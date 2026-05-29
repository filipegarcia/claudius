# Start in plan mode (--permission-mode plan)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
A CLI launch flag (`--permission-mode plan`) that opens a session already in read-only plan mode rather than the default prompt-on-risky-tool posture.

## Claudius today
The browser equivalent of "launch in plan mode" is simply selecting Plan from `components/chat/ModeSelector.tsx` (which posts to `app/api/sessions/[id]/mode/route.ts` with `mode: "plan"`). Session permission-mode defaults also flow through the session creation path (`app/api/sessions/route.ts` + `lib/shared/session-defaults.ts`).

## Decision
Already covered. The CLI launch flag has no separate web surface — in a browser you set the mode on the live session via `ModeSelector`, which is the natural equivalent. Marking exists rather than building a redundant "start in plan mode" toggle.
