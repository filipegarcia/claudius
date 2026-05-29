# /desktop

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** NOT_APPLICABLE

## What it is
`/desktop` (alias `/app`) hands the current terminal/web session off to continue
in Anthropic's Claude Desktop app.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "desktop"`, category
`platform`, `handler: "external"`). The slash dispatcher in
`app/[workspaceId]/page.tsx` treats `external` commands by showing a
`"/desktop is terminal/hosted only"` toast rather than attempting an action.
Claudius is itself the desktop/web surface (Next.js app, also packaged as an
Electron desktop app per `electron/` and `electron-builder.yml`).

## Decision
NOT_APPLICABLE. "Continue in the Desktop app" is a platform hand-off to a separate
Anthropic-hosted client. There is nothing meaningful for Claudius to add — it *is*
the alternative surface a user would hand off *to*, and it has no integration with
the hosted Claude Desktop app to push a session into. The registry already marks it
`external` and the dispatcher gives an honest toast.
