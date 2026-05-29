# claude -r (resume)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude -r <id|name>` resumes a specific prior session by its id (or name).

## Claudius today
The sessions page (`app/[workspaceId]/sessions/page.tsx`) lists sessions and exposes a "Resume" button. The create-session route (`app/api/sessions/route.ts`) takes a `resume` id (and optional `resumeSessionAt`) and re-derives the original cwd from the session JSONL before binding.

## Decision
Already covered. Resume-by-id is implemented end to end: the UI "Resume" action posts the session id to `/api/sessions` with `resume`, which the session manager uses to reconstruct the SDK conversation. No new UI needed.
