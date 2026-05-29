# /export

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Exports the current conversation (e.g. to a downloadable text/markdown file).

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "export"`, handler `native`, `argsHint: "[filename]"`). The dispatcher opens `/api/sessions/export/[id]` in a new tab to download the current session as plain text.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"export"`, around line 695 → `window.open("/api/sessions/export/<id>")`) and the export route. A separate full-transcript view also exists at `app/api/sessions/[id]/transcript`.
