# Cycle permission modes (Shift+Tab)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Shift+Tab cycles the permission posture (Normal → Auto-Accept → Plan, etc.) for the
current session.

## Claudius today
Implemented exactly as in the CLI: a global keydown listener in
`app/[workspaceId]/page.tsx` catches Shift+Tab (when not typing into a non-empty
input) and calls `session.setPermissionMode(nextPermissionMode(...))`. The visible
control is the `ModeSelector` dropdown (`components/chat/ModeSelector.tsx`) in the
StatusLine, whose tooltip reads "Permission mode (Shift+Tab to cycle)" and lists all
modes (default → acceptEdits → auto → plan → dontAsk → bypassPermissions).

## Decision
ALREADY_EXISTS. Both the Shift+Tab chord and the click surface are present —
`ModeSelector` (`components/chat/ModeSelector.tsx`) plus the keydown handler and
`nextPermissionMode` in `app/[workspaceId]/page.tsx`. The mode is also shown as a
pill on the Activity rail's `SessionCard`.
