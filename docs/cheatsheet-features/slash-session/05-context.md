# /context

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Visualizes the context window usage in a grid format, broken down by category (messages, memory files, MCP tools, system prompt, etc.).

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "context"`, handler `native`). The dispatcher opens the `ContextOverlay`, which renders the grid of colored squares, per-category token counts, memory files, MCP tools, and deferred built-in tools, fed by the `GET /api/sessions/[id]/context` route.

## Decision
ALREADY_EXISTS. Covered by the native dispatcher in `app/[workspaceId]/page.tsx` (`runNative` case `"context"`, around line 817 → `setOverlay("context")`), `components/overlays/ContextOverlay.tsx`, and the `app/api/sessions/[id]/context/route.ts` backend.
