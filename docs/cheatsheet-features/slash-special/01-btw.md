# /btw

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/btw <question>` asks Claude a side question that does not get added to the
conversation history and runs without tools — an ephemeral aside that leaves the
main thread untouched.

## Claudius today
Registered in the canonical slash registry at `lib/shared/slash-commands.ts`
(`id: "btw"`, category `memory`, `handler: "sdk"`, `argsHint: "<question>"`). The
slash dispatcher in `app/[workspaceId]/page.tsx` (`handleSend`, the
`cmd?.handler === "sdk"` branch around line 911) forwards it to the agent via
`session.send(text, undefined, { asSlashCommand: true })`, so the SDK interprets
the `/btw` semantics. It also shows up in the `/help` picker (`HelpOverlay`) and
the inline slash autocomplete in `PromptInput.tsx`.

## Decision
ALREADY_EXISTS. The feature is an SDK-interpreted command: the browser correctly
forwards it through the existing slash-command send path (`asSlashCommand`),
surfaces it in the command picker and help overlay, and renders the agent's reply
inline. The ephemeral/no-history behavior is enforced by the SDK itself, so no
additional browser surface is warranted — it works as a chat control today.
