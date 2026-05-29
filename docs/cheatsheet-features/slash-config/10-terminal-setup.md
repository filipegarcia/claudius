# /terminal-setup

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** NOT_APPLICABLE

## What it is
`/terminal-setup` configures terminal-specific keybindings (e.g. installing
Shift+Enter / Option+Enter newline handling for iTerm2, VS Code terminal,
etc.) so multiline input works in your specific terminal emulator.

## Claudius today
No surface, and none is needed. A repo-wide search for `terminal-setup` /
`terminalSetup` finds nothing outside this triage tooling. Claudius is a
browser app: the composer (`components/chat/PromptInput.tsx`) already handles
Shift+Enter for newlines and Enter to submit directly in the DOM, with no
terminal emulator in the loop. The CLI keybindings that *do* make sense in the
browser are editable on `app/[workspaceId]/keybindings/page.tsx`.

## Decision
NOT_APPLICABLE. `/terminal-setup` exists purely to patch a host terminal
emulator's key handling — a problem that does not exist when input is a browser
textarea. There is no terminal to configure, so there is no browser surface to
build. Multiline / submit behavior is already correct in `PromptInput.tsx`.
