# Rewind or summarize (Esc+Esc)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Double-Esc rewinds the conversation to an earlier point (forking from a chosen
message) or summarizes/compacts it to recover context.

## Claudius today
Rewind: hovering any user message in `MessageList` reveals a Rewind control that
calls `onRewind` (`app/[workspaceId]/page.tsx`), which POSTs to
`app/api/sessions/fork/route.ts` with `upToMessageId` and navigates to the new
forked session. `RewindFilesButton` (`components/chat/RewindFilesButton.tsx`) also
surfaces file-state rewind. Summarize/compact: the StatusLine "Compact" button and
the `ContextWarningBanner` both run `/compact` via `startCompaction`
(`components/chat/StatusLine.tsx`, `app/[workspaceId]/page.tsx`).

## Decision
ALREADY_EXISTS. Rewind is a hover action on user messages (fork API at
`app/api/sessions/fork/route.ts`); summarize is the Compact button +
`ContextWarningBanner` running `/compact`. The CLI `/rewind` command's `runNative`
handler points the user at the hover control.
