# /init

**Source:** Claude Code cheat sheet — Slash Commands — Tools
**Status:** ALREADY_EXISTS

## What it is
`/init` asks Claude to scan the repo and write a starter `CLAUDE.md` documenting
the codebase, conventions, and commands.

## Claudius today
`/init` is registered in `lib/shared/slash-commands.ts` with `handler: "sdk"`
(category `memory`). When typed in the composer, `handleSend` in
`app/[workspaceId]/page.tsx` routes any `sdk`-handler command through
`session.send(text, undefined, { asSlashCommand: true })`, so the SDK receives
`/init` verbatim and Claude Code performs the initialization, streaming the
resulting system/init message and the generated `CLAUDE.md` write back into the
chat. The produced file is then editable on the Memory page
(`app/[workspaceId]/memory/page.tsx`), which is a full CLAUDE.md editor across
user/project/project-claude/local scopes.

## Decision
ALREADY_EXISTS. `/init` works today via the SDK forward path in
`app/[workspaceId]/page.tsx` (the `cmd?.handler === "sdk"` branch), and the
resulting CLAUDE.md is viewable/editable at `/memory`. No new surface needed —
generating a CLAUDE.md is inherently an agent action, and the registry already
classifies it correctly as `sdk`.
