# /help

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/help` shows the available slash commands and keyboard shortcuts.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "help"`, category `info`,
`handler: "native"`). The dispatcher in `app/[workspaceId]/page.tsx`
(`runNative`, `case "help"`) opens the `HelpOverlay`
(`components/overlays/HelpOverlay.tsx`), a searchable, category-grouped browser of
every slash command. The overlay merges the curated registry with live
SDK/plugin commands via `mergeSuggestions` and enriches them with real
descriptions/argument hints from `useSdkCommands` (the SDK `supportedCommands()`
control request).

## Decision
ALREADY_EXISTS. Covered by the native `/help` handler and the `HelpOverlay`
command browser. Keyboard shortcuts are separately discoverable via the
remappable client shortcut registry (`lib/client/shortcuts.ts`) and the
`/keybindings` page. No new surface needed.
