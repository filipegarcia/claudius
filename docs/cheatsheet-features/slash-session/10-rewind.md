# /rewind

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Rewinds the conversation to a previous user message and/or restores the code (file) checkpoint at that point.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "rewind"`, aliases `checkpoint`/`undo`, handler `native`). Every user message in the transcript exposes two ↺ affordances: `onRewind` forks the conversation back to that message, and `RewindFilesButton` (`components/chat/RewindFilesButton.tsx`) restores the working tree to that message's file checkpoint via the SDK. Backed by `POST /api/sessions/[id]/rewind`.

## Decision
ALREADY_EXISTS. Covered by `components/chat/UserMessage.tsx` (the `onRewind` + `RewindFilesButton` hover controls, around lines 88-100) and the `app/api/sessions/[id]/rewind/route.ts` backend. The native dispatcher's `/rewind` case (around line 882) is a hint that directs users to those per-message controls.
