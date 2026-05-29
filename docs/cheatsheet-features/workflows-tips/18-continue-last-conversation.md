# Continue last conversation (claude -c)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`claude -c` resumes the most recent conversation where you left off, without picking it from a list.

## Claudius today
Sessions persist and are resumable: `components/chat/SessionPicker.tsx`, the sessions page (`app/[workspaceId]/sessions/page.tsx`), and the session-resume server path (`lib/server/session-resume.ts`) restore prior conversations. The session tab strip (`components/chat/SessionTabs.tsx`) keeps recent sessions one click away, and `/resume` (alias `/continue`) is a native command in `lib/shared/slash-commands.ts`.

## Decision
Already covered. In a persistent browser app the "continue last conversation" affordance is the always-present session list/tabs and the `/resume` picker — the most recent session is right there to reopen. No new UI needed.
