# /compact

**Source:** Claude Code cheat sheet — Slash Commands — Session
**Status:** ALREADY_EXISTS

## What it is
Compacts the conversation to free up context, with optional focus instructions to bias what is retained in the summary.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "compact"`, handler `sdk`, `argsHint: "[focus instructions]"`). It is forwarded to the SDK rather than intercepted: the chat dispatcher routes any `/compact …` through the no-echo `asSlashCommand` path so the chat shows a "Running /compact…" pill, and the SDK's `compact_boundary` reply lands as its own event.

## Decision
ALREADY_EXISTS. Covered by the SDK-forwarding branch in `app/[workspaceId]/page.tsx` (`handleSend`, the `cmd?.handler === "sdk"` block around line 911) plus `session.send(text, undefined, { asSlashCommand: true })` in `lib/client/use-session.ts`. The optional focus argument is passed through verbatim to the SDK, so no extra browser surface is warranted.
