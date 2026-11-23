# --dangerously-skip-permissions

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** NOT_APPLICABLE

## What it is
A Claude Code CLI launch flag that starts a session with all permission prompts skipped (every tool auto-allowed). It is the command-line equivalent of selecting the `bypassPermissions` mode.

## Claudius today
Claudius is a browser wrapper around the Agent SDK; it does not launch sessions via the `claude` CLI, so there is no CLI flag to surface. The equivalent capability is already exposed as the `bypassPermissions` permission mode (see `components/chat/ModeSelector.tsx` and `app/api/sessions/[id]/mode/route.ts`). The StatusLine's "Copy session ID" button (`components/chat/StatusLine.tsx`) copies just the raw session id, so users who want to reattach from the terminal compose their own `claude --resume <id>` (with or without this flag).

## Decision
NOT_APPLICABLE. This is a CLI-only launch flag with no distinct browser surface to build: its in-app behavior is already fully covered by the `bypassPermissions` mode in the chat `ModeSelector` and the workspace default in `components/workspaces/WorkspaceForm.tsx`. No new UI warranted.
