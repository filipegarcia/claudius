# /clear

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Clears the conversation history and starts a fresh session, freeing the context window.

## Claudius today
Defined in the registry (`lib/shared/slash-commands.ts`, `id: "clear"`, aliases `reset`/`new`, handler `native`) and dispatched in the workspace chat page. Typing `/clear` runs `session.createNewSession()` and shows a "New session" toast.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"clear"`, around line 656), backed by `session.createNewSession()` in `lib/client/use-session.ts`. The "+ / New session" affordances in the chat header and SessionTabs cover the same action via the UI.
