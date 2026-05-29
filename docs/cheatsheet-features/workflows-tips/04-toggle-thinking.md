# Toggle thinking (Alt+T)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Alt+T is a terminal chord that toggles extended thinking for supported models on or off for the session.

## Claudius today
Two related browser surfaces cover this. (1) The thinking *behavior* is governed by the `alwaysThinkingEnabled` and `showThinkingSummaries` settings rendered in the "Thinking & effort" section of `app/settings/page.tsx`. (2) Per-turn adaptive thinking is the "Auto" effort chip in `components/panels/widgets/ModelPicker.tsx` (gated on `supportsAdaptiveThinking`), backed by `app/api/sessions/[id]/effort/route.ts`. Rendered thinking content appears in `components/chat/ThinkingBlock.tsx`.

## Decision
Already covered. The Alt+T chord itself is terminal-only, but its meaning — enabling/disabling thinking — is exposed as the `alwaysThinkingEnabled`/`showThinkingSummaries` settings in `app/settings/page.tsx` plus the adaptive "Auto" effort control in the model picker. No new UI needed.
