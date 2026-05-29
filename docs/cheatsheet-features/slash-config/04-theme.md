# /theme

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/theme` creates/switches named themes, including an "Auto (match terminal)"
mode and dark/light variants.

## Claudius today
Two distinct theme controls live on the Settings page
(`app/settings/page.tsx`). (1) "Web app theme" — switches the Claudius browser
UI between named themes (Dark, Light, Midnight, Paper, TUI, TUI Light,
Synthwave) via `lib/client/theme.ts`, persisted to localStorage. (2) "Theme
(CLI rendering)" — the persisted `theme` key written to `settings.json`, with
the SDK's own theme set (`auto`, `dark`, `light`, `dark-daltonized`,
`light-daltonized`, `ansi`) where `auto` is the match-terminal option.

## Decision
ALREADY_EXISTS. The Settings page covers both halves of `/theme`: a rich named
theme switcher for the browser UI and the `settings.json` `theme` enum
(including `auto`) for CLI rendering. The "create custom named theme" nuance is
the only gap, and Claudius already ships a fixed palette of named themes plus a
whole `/customize` system for deeper changes — not worth a bespoke theme-author
UI. No new surface needed.
