# Compact with focus (/compact)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`/compact [focus instructions]` compresses the conversation to free up context, optionally steered by focus instructions describing what to preserve.

## Claudius today
`/compact` is registered in `lib/shared/slash-commands.ts` as an `sdk`-handler command with an `argsHint: "[focus instructions]"`. The slash picker (`components/chat/SlashCommandPicker.tsx`) surfaces it with that hint, and the composer (`components/chat/PromptInput.tsx`) forwards it to the SDK, which performs the compaction. The context warning banner also suggests compaction as usage grows.

## Decision
Already covered. As an SDK-forwarded slash command surfaced by the picker (with the focus-instructions arg hint) and forwarded by the composer, `/compact` is a working browser surface — `lib/shared/slash-commands.ts` + `components/chat/SlashCommandPicker.tsx`. No new UI needed.
