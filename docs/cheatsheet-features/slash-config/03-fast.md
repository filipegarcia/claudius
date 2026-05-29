# /fast

**Source:** Claude Code cheat sheet — Slash Commands — Config
**Status:** ALREADY_EXISTS

## What it is
`/fast` toggles "fast mode" on and off — a lower-latency response mode on
models that support it.

## Claudius today
Fast mode has two real surfaces. (1) The persisted `fastMode` boolean is a
labeled field in the Settings catalog (`app/settings/page.tsx`, "Model &
behavior" section: "When true, fast mode is enabled."), written to
`settings.json`. (2) The live per-turn fast-mode state is surfaced in chat:
`use-session.ts` tracks `fastModeState` ("off" | "cooldown" | "on") reported by
the SDK result event, and `components/chat/StatusLine.tsx` renders it as the
"⚡ on / cooldown" badge. The ModelPicker also shows a "fast" capability badge
per model. Note: the live on/off is an automatic SDK behavior (with a cooldown
state), so Claudius shows it as status rather than a manual chat toggle; the
durable enable/disable lives in Settings.

## Decision
ALREADY_EXISTS. The persisted toggle lives in the Settings catalog
(`fastMode`) and the live state is shown in `StatusLine.tsx` /
`ModelPicker.tsx`. There is no separate manual chat toggle because fast mode is
SDK-managed (auto + cooldown); a fake on/off switch would fight the SDK's own
state. The browser surfaces that make sense already exist.
