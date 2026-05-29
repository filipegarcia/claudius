# default

**Source:** Claude Code cheat sheet — Permission Modes
**Status:** ALREADY_EXISTS

## What it is
The standard permission mode: Claude prompts for confirmation before running risky tools (edits, bash, etc.). Anything not pre-approved triggers an interactive approval prompt.

## Claudius today
This is the first entry in `PERMISSION_MODE_ORDER` in `components/chat/ModeSelector.tsx` (label "Default", description "Prompt for risky tools") and is the server default in `lib/server/session.ts` (`this.permissionMode = opts.permissionMode ?? "default"`). The mode is read/written over `app/api/sessions/[id]/mode/route.ts` and surfaced in the chat status bar via `<ModeSelector>` mounted in `components/chat/StatusLine.tsx`.

## Decision
ALREADY_EXISTS. Selectable from the in-chat `ModeSelector` dropdown (`components/chat/StatusLine.tsx` line 316) and cycled via Shift+Tab; persisted through `app/api/sessions/[id]/mode/route.ts`. Approval prompts themselves are handled by the ask/answer flow (`app/api/sessions/[id]/ask-answer`). No new surface needed.
