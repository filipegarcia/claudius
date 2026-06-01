# Detailed 'Fast mode disabled — <reason>' diagnostics

**Source:** Claude Code TUI — error & recovery
**Status:** MISSING

## What it is
The TUI distinguishes six concrete reasons Fast mode is off instead of a generic
"off" — telling the power user which lever to pull. The six verbatim strings:
`Fast mode disabled \n usage credits exhausted`,
`Fast mode disabled \n usage credits turned off by your organization`,
`Fast mode disabled \n usage credit limit reached`,
`Fast mode disabled \n usage credits turned off for your account`,
`Fast mode disabled \n usage credits not available for your plan`,
`Fast mode disabled \n usage credits not available`.

## Claudius today
Not surfaced in Claudius. `lib/client/use-session.ts` models `fastModeState` as
`"off" | "cooldown" | "on" | null` (line 518), and the SSE payload
(`fast_mode_state?: "off" | "cooldown" | "on"` at line 2666) carries no
disabled-reason field. `components/chat/StatusLine.tsx` hides the chip entirely
when state is `"off"` (`fastModeState && fastModeState !== "off"`, line 270), so
even a generic "off" never renders — let alone a reason.
`app/api/sessions/[id]/fast/route.ts` is a pure write endpoint
(`session.setFast()` → `applyFlagSettings({ fastMode })`) and doesn't read back
a disabled-reason from the SDK. A natural home would be an optional
`fastModeDisabledReason` field on the session state, surfaced as a muted-amber
chip in `components/chat/StatusLine.tsx` or as a tooltip on the Fast-mode
toggle in `components/panels/widgets/ModelPicker.tsx`.

## Decision
MISSING. The browser today collapses all six TUI cases into a single hidden
`"off"`. Worth adding once the SDK exposes the reason field: thread it through
the existing `fast_mode_state` SSE message in `lib/server/session.ts` as a
sibling `fast_mode_disabled_reason`, store it on `use-session.ts`, and render
it as a small chip or tooltip next to the Fast-mode toggle in `ModelPicker.tsx`
so the user sees "credits exhausted" vs "turned off by your organization"
without having to dig.
