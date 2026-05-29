# /color

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** NOT_APPLICABLE

## What it is
`/color` sets the color of the terminal prompt bar (the input line where you
type).

## Claudius today
No surface, and none is warranted. Claudius has no "prompt bar color" knob — a
search across the repo for `accentColor` / `promptBarColor` / `prompt-color`
finds nothing (only an unrelated CSS comment in `app/globals.css`). The chat
composer (`components/chat/PromptInput.tsx`) is styled by the active theme's
CSS variables, and overall appearance is already controlled by the "Web app
theme" switcher in Settings (`app/settings/page.tsx` + `lib/client/theme.ts`).

## Decision
NOT_APPLICABLE. `/color` is a terminal-prompt cosmetic that doesn't map onto a
browser UI — in Claudius the composer's color is owned by the theme system, and
the named-theme switcher already covers "change how the input area looks." A
standalone per-element color picker would be cosmetic clutter with no Claude
Code settings.json backing. The right surface (theme selection) already exists.
