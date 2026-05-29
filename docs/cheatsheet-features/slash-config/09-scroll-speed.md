# /scroll-speed

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** NOT_APPLICABLE

## What it is
`/scroll-speed` adjusts how fast the terminal output scrolls in response to
scroll-wheel / keyboard scroll input.

## Claudius today
No surface, and none is warranted. A repo-wide search for `scroll-speed` /
`scrollSpeed` finds nothing outside this triage tooling. Scrolling in the
browser chat transcript is handled natively by the browser/OS — the message
list (`components/chat/MessageList.tsx`) is a normal scroll container, so the
user's own OS and browser scroll settings already govern speed.

## Decision
NOT_APPLICABLE. Scroll speed is a terminal-emulator concern. In a browser the
OS/browser owns wheel and trackpad scroll speed and there is no Claude Code
settings.json value behind it — re-implementing a custom scroll-speed
multiplier would fight native scrolling and add no value. No browser surface.
