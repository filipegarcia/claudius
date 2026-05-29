# bypassPermissions

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** ALREADY_EXISTS

## What it is
A mode that never prompts and auto-allows every tool call — the "skip all prompts" posture. Dangerous, intended for trusted, sandboxed, or unattended runs.

## Claudius today
Defined in `components/chat/ModeSelector.tsx` (`bypassPermissions`, label "Bypass", "Never prompt — auto-allow everything (dangerous)", red ShieldOff icon) and allowed in `app/api/sessions/[id]/mode/route.ts`. It is also the default for newly created workspaces in `components/workspaces/WorkspaceForm.tsx` (prefilled so agents can run unattended out of the box) and is offered as a workspace-default option there.

## Decision
ALREADY_EXISTS. Selectable in the chat `ModeSelector` (with a clear "dangerous" red treatment), persisted via `app/api/sessions/[id]/mode/route.ts`, and exposed as a per-workspace default in `components/workspaces/WorkspaceForm.tsx`. No new surface needed.
