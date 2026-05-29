# /undo

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
An alias for rewinding the conversation — steps back to a previous point.

## Claudius today
Registered as an alias of `rewind` in `lib/shared/slash-commands.ts` (`id: "rewind"`, aliases `checkpoint`/`undo`, handler `native`). The same machinery powers it: per-message rewind controls in the transcript (fork-the-conversation `onRewind` and working-tree `RewindFilesButton`), backed by `POST /api/sessions/[id]/rewind`.

## Decision
ALREADY_EXISTS. Resolves to the same surface as `/rewind` (see 10-rewind). The native dispatcher's `rewind` case in `app/[workspaceId]/page.tsx` (around line 882) points the user at the per-message ↺ controls in `components/chat/UserMessage.tsx`.
