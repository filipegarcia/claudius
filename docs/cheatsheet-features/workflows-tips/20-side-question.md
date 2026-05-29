# Side question (/btw)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
`/btw <question>` asks a side question that's ephemeral — no tools, no added history — so it doesn't pollute the main conversation's context.

## Claudius today
`/btw` is registered in `lib/shared/slash-commands.ts` (category "memory", `sdk` handler, `argsHint: "<question>"`, described as "Side question — ephemeral, no tools, no history."). The slash picker (`components/chat/SlashCommandPicker.tsx`) surfaces it with that hint and the composer (`components/chat/PromptInput.tsx`) forwards it to the SDK, which handles the ephemeral behavior.

## Decision
Already covered. As an SDK-forwarded slash command surfaced by the picker and forwarded by the composer, `/btw` is a working browser surface — `lib/shared/slash-commands.ts` + `components/chat/SlashCommandPicker.tsx`. No new UI needed.
