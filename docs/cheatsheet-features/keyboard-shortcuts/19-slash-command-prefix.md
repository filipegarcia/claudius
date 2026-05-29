# Slash command prefix (/)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Typing `/` at the start of the prompt invokes a slash command, with an
autocomplete picker of available commands.

## Claudius today
`components/chat/PromptInput.tsx` opens the `SlashCommandPicker`
(`components/chat/SlashCommandPicker.tsx`) when the line matches `^\s*\/\S*$`
(`refreshPickerState`). It merges the curated registry (`lib/shared/slash-commands.ts`),
SDK-advertised commands, skills, and rich command metadata from `useSdkCommands`.
On submit, `handleSend` (`app/[workspaceId]/page.tsx`) dispatches native commands
(`runNative`), routes SDK commands through `session.send`, and flags external-only
ones.

## Decision
ALREADY_EXISTS. The `/` prefix + autocomplete is fully implemented in
`components/chat/PromptInput.tsx` / `components/chat/SlashCommandPicker.tsx`, with a
complete dispatch layer in `app/[workspaceId]/page.tsx`. It's also discoverable via
the Command Palette (`components/overlays/CommandPalette.tsx`).
