# --dangerously-skip-permissions

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** NOT_APPLICABLE

## What it is
A Claude Code CLI launch flag that starts a session with all permission prompts skipped (every tool auto-allowed). It is the command-line equivalent of selecting the `bypassPermissions` mode.

## Claudius today
Claudius is a browser wrapper around the Agent SDK; it does not launch sessions via the `claude` CLI, so there is no CLI flag to surface. The equivalent capability is already exposed as the `bypassPermissions` permission mode (see `components/chat/ModeSelector.tsx` and `app/api/sessions/[id]/mode/route.ts`). The literal flag does appear once in `components/chat/StatusLine.tsx` (line 431) only inside the "copy resume command" snippet — a convenience string for users who want to reattach to the same SDK session from the terminal — not as a Claudius control.

## Decision
NOT_APPLICABLE. This is a CLI-only launch flag with no distinct browser surface to build: its in-app behavior is already fully covered by the `bypassPermissions` mode in the chat `ModeSelector` and the workspace default in `components/workspaces/WorkspaceForm.tsx`. The only place the literal flag matters in the browser is the informational resume-command copy button in `components/chat/StatusLine.tsx`, which already includes it. No new UI warranted.
