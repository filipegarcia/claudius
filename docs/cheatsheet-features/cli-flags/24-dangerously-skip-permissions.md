# --dangerously-skip-permissions

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--dangerously-skip-permissions` disables all permission prompts and auto-allows every tool call (the YOLO mode).

## Claudius today
This is the `bypassPermissions` permission mode, exposed in the ModeSelector (`components/chat/ModeSelector.tsx`, labeled "Bypass — Never prompt, auto-allow everything (dangerous)") and settable via `app/api/sessions/[id]/mode/route.ts`. It's also a selectable workspace default in `components/workspaces/WorkspaceForm.tsx`. The settings catalog exposes `skipDangerousModePermissionPrompt` (the "I accepted the dialog" flag).

## Decision
Already covered. Bypass mode is the browser equivalent of `--dangerously-skip-permissions`, available both per session (ModeSelector) and as a workspace default. No new UI needed.
