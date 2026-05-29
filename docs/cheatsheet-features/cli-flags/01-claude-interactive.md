# claude (interactive)

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
Running `claude` with no arguments starts an interactive Claude Code session in the current directory.

## Claudius today
The entire Claudius app is the browser equivalent of an interactive session. The workspace root page (`app/[workspaceId]/page.tsx`) is the live chat surface, backed by the session manager and SSE streaming in `lib/server/session.ts`.

## Decision
Already covered. The interactive session is the product's core: the chat page at `app/[workspaceId]/page.tsx` with the composer (`components/chat/PromptInput.tsx`) and session lifecycle in `lib/server/session-manager.ts`. No new UI needed.
