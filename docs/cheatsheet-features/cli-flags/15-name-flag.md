# -n / --name

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`-n` / `--name` assigns a human-readable name to the session.

## Claudius today
Sessions can be renamed via `app/api/sessions/rename/route.ts` (routes through `session.rename` for live sessions so the new title broadcasts to all SSE subscribers, or writes the JSONL directly for unbound ones). Session tabs (`components/chat/SessionTabs.tsx`) and the sessions list display and edit titles.

## Decision
Already covered. Session naming/renaming is implemented end to end with live broadcast. No new UI needed.
