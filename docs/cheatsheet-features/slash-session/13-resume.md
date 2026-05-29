# /resume

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Resumes a previous session by ID or name (or opens a session picker).

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "resume"`, alias `continue`, handler `native`, `argsHint: "[id]"`). With an argument the dispatcher navigates to `/?session=<id>`; without one it opens the Sessions list. A `SessionPicker` component and the `app/[workspaceId]/sessions` page provide the browse-and-resume UI.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"resume"`, around line 661), `components/chat/SessionPicker.tsx`, and the sessions page/routes (`app/[workspaceId]/sessions/page.tsx`, `/api/sessions`).
