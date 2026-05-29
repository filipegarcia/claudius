# acceptEdits

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** ALREADY_EXISTS

## What it is
A permission mode that automatically accepts file edits while still prompting for other risky tools (e.g. bash).

## Claudius today
Defined in `components/chat/ModeSelector.tsx` (`acceptEdits`, label "Accept edits", description "Auto-approve file edits, prompt for the rest", ShieldCheck icon). Listed in the API allow-list in `app/api/sessions/[id]/mode/route.ts`. It is also the mode the session auto-switches to when a plan is accepted (`lib/server/session.ts` line 1217: `this.permissionMode = "acceptEdits"`), and is exposed as a workspace default option in `components/workspaces/WorkspaceForm.tsx`.

## Decision
ALREADY_EXISTS. Selectable in the chat `ModeSelector`, persisted via `app/api/sessions/[id]/mode/route.ts`, and available as a per-workspace default in `components/workspaces/WorkspaceForm.tsx`. No new surface needed.
