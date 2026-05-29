# /keybindings

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/keybindings` customizes keyboard shortcuts (the CLI's input keybindings).

## Claudius today
There are two complementary surfaces. (1) The CLI keybindings editor at
`app/[workspaceId]/keybindings/page.tsx` (SideNav "keybindings" tile, with a
bare-path redirect stub at `app/keybindings/page.tsx`). It edits the
`keybindings.json` file (key / chord / command / when / args) in both a form
and a Raw JSON view, via the `/api/keybindings` route and
`lib/server/keybindings.ts`. (2) The browser-app shortcuts (tab cycling,
SideNav nav, workspace cycling) are remappable in the Settings page's
"Shortcuts" section (`components/settings/ShortcutsSection.tsx`,
`lib/client/shortcuts.ts`).

## Decision
ALREADY_EXISTS. The CLI keybindings page
(`app/[workspaceId]/keybindings/page.tsx`) is the direct equivalent of
`/keybindings`, and the web-app shortcut registry is separately editable in
Settings. No new surface needed.
