# Toggle transcript viewer (Ctrl+O)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Ctrl+O opens a full transcript viewer with focus cycling, letting the user scroll
through and inspect the raw conversation history.

## Claudius today
Claudius renders the full transcript inline in the chat pane (`MessageList` in
`components/chat/MessageList.tsx`) and provides a dedicated transcript viewer at
`components/sessions/TranscriptViewer.tsx` (reachable from the Sessions page and
the session export/transcript flows). Transcript search (Cmd+F) is wired in
`app/[workspaceId]/page.tsx` via `TranscriptSearch`, with jump-to-message and
highlight.

## Decision
ALREADY_EXISTS. The transcript is a first-class browser surface: the live
`MessageList`, the `components/sessions/TranscriptViewer.tsx` component, and
`TranscriptSearch` (Cmd+F) covering navigation/inspection. No separate toggle is
needed because the transcript is always visible in the browser layout.
