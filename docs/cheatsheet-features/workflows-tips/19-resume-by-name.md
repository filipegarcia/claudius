# Resume by name (claude -r)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`claude -r` resumes a specific named/selected session rather than the most recent one.

## Claudius today
`components/chat/SessionPicker.tsx` and the sessions page (`app/[workspaceId]/sessions/page.tsx`) let you pick any prior session by title and reopen it; sessions can be renamed (`/rename`, `app/api/sessions/[id]/rename`... and the sessions API). The `/resume [id]` command is registered native in `lib/shared/slash-commands.ts`, and resume restores state through `lib/server/session-resume.ts`.

## Decision
Already covered. Picking a specific session by name is exactly what the session picker / sessions page provides, plus the `/resume [id]` command. No new UI needed.
