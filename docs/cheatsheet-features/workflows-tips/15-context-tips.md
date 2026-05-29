# Context tips (/context)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`/context` visualizes context-window usage and offers tips for optimizing it (which categories, memory files, and MCP tools are consuming tokens).

## Claudius today
`components/overlays/ContextOverlay.tsx` renders a full context breakdown from `app/api/sessions/[id]/context/route.ts`: total/used/free tokens, a stacked-bar usage chart, per-category token counts, memory files, MCP tools (loaded vs deferred), and deferred built-in tools. The `/context` command is registered as a native command in `lib/shared/slash-commands.ts`. A `components/chat/ContextWarningBanner.tsx` plus `lib/client/useContextWatcher.ts`/`useContextWarning.ts` proactively warn as usage climbs.

## Decision
Already covered. `ContextOverlay` is the dedicated `/context` browser surface, with warning banners for optimization prompts. No new UI needed.
