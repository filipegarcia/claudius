# /rename

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/rename [title]` renames the current session.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "rename"`, category `session`,
`handler: "native"`, `argsHint: "[title]"`). The dispatcher in
`app/[workspaceId]/page.tsx` (`runNative`, `case "rename"`) either renames inline
when a title argument is given (POST `/api/sessions/rename`) or opens the
`RenameOverlay` (`components/overlays/RenameOverlay.tsx`) when called bare. The
backend `app/api/sessions/rename/route.ts` routes through the live
`Session.rename` when the session is in memory (so the new title broadcasts to all
SSE subscribers immediately) and falls back to the SDK/JSONL path otherwise.

## Decision
ALREADY_EXISTS. Fully covered by the native slash handler, the `RenameOverlay`,
and `app/api/sessions/rename/route.ts`. No new surface needed.
