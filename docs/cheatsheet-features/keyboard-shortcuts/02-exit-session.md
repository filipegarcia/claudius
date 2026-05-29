# Exit session (Ctrl+D)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
Ctrl+D sends EOF to the terminal, ending the interactive Claude Code session and
returning to the shell.

## Claudius today
There is no terminal to send EOF to — Claudius is a long-lived browser app, not a
process you exit. The "leave this session" capability is covered by closing the
session tab (`closeTab` in `app/[workspaceId]/page.tsx`, Cmd+W /
`tab.close` in `lib/client/shortcuts.ts`) and by the `/exit` slash command, which
`runNative` routes to the Sessions list (`router.push("/sessions")`).

## Decision
NOT_APPLICABLE. Ctrl+D is a terminal EOF control with no browser equivalent — the
app does not "exit." The underlying "leave the session" intent is already served
by tab-close (Cmd+W) and the `/exit` command, so no new surface is warranted.
