# claude -c (continue)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`claude -c` continues the most recent session in the current directory instead of starting fresh.

## Claudius today
The sessions page (`app/[workspaceId]/sessions/page.tsx`) lists prior sessions for the workspace with a "Resume" action; the create-session route (`app/api/sessions/route.ts`) accepts a `resume` id and reconstructs the original cwd from the session's JSONL on disk.

## Decision
Already covered. Resuming the most recent session is the same code path as resume-by-id (`-r`): the sessions list shows recent sessions newest-first and "Resume" re-binds them. The session tabs (`components/chat/SessionTabs.tsx`) and recently-closed-tab restore (Cmd+Shift+T) further cover "continue where I left off."
