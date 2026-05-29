# /effort

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/effort` sets the reasoning effort level (low / medium / high / xhigh / max),
typically via an interactive slider.

## Claudius today
Live effort control is built into the model picker
(`components/panels/widgets/ModelPicker.tsx`): when the active model supports
effort, an "Effort" row renders chips for each supported level (Low, Medium,
High, Very High, Max) plus an "Auto" (adaptive thinking) chip. Selecting a
level POSTs to `app/api/sessions/[id]/effort/route.ts`, which calls
`session.setEffort(...)` (the SDK's `applyFlagSettings`, since the `/effort`
slash command doesn't exist in the SDK environment). The persisted default
`effortLevel` enum is also a labeled field in the Settings catalog
(`app/settings/page.tsx`, "Thinking & effort").

## Decision
ALREADY_EXISTS. Effort selection is a first-class chat control via the effort
chip row in `ModelPicker.tsx` backed by `/api/sessions/[id]/effort`, plus the
persisted `effortLevel` in Settings. Claudius uses tap-to-select chips rather
than a drag slider, which is the better web idiom for a 5-value discrete scale
— same capability, no new surface needed.
