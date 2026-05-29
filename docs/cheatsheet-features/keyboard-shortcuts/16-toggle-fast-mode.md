# Toggle fast mode (Option+O)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Option+O toggles "fast mode" — accelerated responses (on supported models like
Opus 4.8).

## Claudius today
Toggle: the `/fast [on|off]` slash command is registered in
`lib/shared/slash-commands.ts` (handler `sdk`), so typing it in the composer routes
to the SDK which flips fast mode. State: `use-session.ts` tracks `fastModeState`
("off" | "cooldown" | "on") from the SDK result stream, and the StatusLine
(`components/chat/StatusLine.tsx`) renders a "⚡ on / cooldown" chip when active.
`ModelPicker` also shows a "fast" capability badge on models that support it.

## Decision
ALREADY_EXISTS. Fast mode is toggled via the `/fast` slash command (the SDK owns
the state), and its current state is surfaced as a chip in
`components/chat/StatusLine.tsx`. The literal Option+O chord isn't bound, but the
capability is reachable and observable from the browser.
