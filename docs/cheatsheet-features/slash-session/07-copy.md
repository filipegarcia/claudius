# /copy

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Copies the last (or a specified) assistant response to the clipboard.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "copy"`, category `ui`, handler `native`, `argsHint: "[N]"`). The dispatcher finds the most recent assistant message, joins its text blocks, and writes them to the clipboard with a "Copied last response" toast.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"copy"`, around line 866) via `navigator.clipboard.writeText`. (Note: the implementation always copies the last assistant response; the `[N]` "specified response" argument from the cheat sheet is not yet honored, but this is a minor enhancement, not a missing surface.)
