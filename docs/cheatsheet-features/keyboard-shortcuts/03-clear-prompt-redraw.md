# Clear prompt + redraw (Ctrl+L)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
Ctrl+L clears the terminal screen and redraws the prompt — the classic shell
"clear" — without touching the conversation.

## Claudius today
There is no terminal frame buffer to clear or redraw. The browser repaints the DOM
on its own; the chat transcript scrolls in a normal container. The "start fresh"
intent (a new conversation) is a separate, already-covered feature: the StatusLine
"Clear" button (`components/chat/StatusLine.tsx`) and `/clear`, both of which spin
up a new session.

## Decision
NOT_APPLICABLE. Ctrl+L is a terminal screen-redraw with no browser meaning (Ctrl+L
focuses the address bar in a browser). There is nothing to draw or clear at the
glyph level, and the conversation-reset intent already has a button.
