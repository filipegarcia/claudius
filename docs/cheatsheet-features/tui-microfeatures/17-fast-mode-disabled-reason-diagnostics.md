# Detailed 'Fast mode disabled — <reason>' diagnostics

**Source:** Claude Code TUI — ambient status line
**Status:** MISSING

## What it is
When Fast mode is off, the TUI doesn't just say "off" — it tells the user *why*
out of six concrete reasons, so they know which lever to pull (top up credits,
ask the org admin, upgrade the plan, etc.). The six verbatim strings:
`Fast mode disabled \n usage credits exhausted`,
`… usage credits turned off by your organization`,
`… usage credit limit reached`,
`… usage credits turned off for your account`,
`… usage credits not available for your plan`,
`… usage credits not available`.

## Claudius today
Not surfaced in Claudius. `lib/client/use-session.ts` and `lib/client/types.ts`
model `fastModeState` as `"off" | "cooldown" | "on" | null` only — no reason
field — and the SSE payload in `use-session.ts` (`fast_mode_state?: "off" |
"cooldown" | "on"`) carries no disabled-reason. `components/chat/StatusLine.tsx`
hides the chip entirely when state is `"off"` (line 247:
`fastModeState && fastModeState !== "off"`), so even a generic "off" never
renders, let alone a reason. `app/api/sessions/[id]/fast/route.ts` is a pure
write endpoint (calls `session.setFast()` → `applyFlagSettings({ fastMode })`)
and doesn't read back a disabled-reason from the SDK. A natural home would be a
new optional `fastModeDisabledReason` field on the session state, surfaced as a
muted-amber chip in `components/chat/StatusLine.tsx` (or a tooltip on the Fast
mode toggle in `components/panels/widgets/ModelPicker.tsx`).

## Decision
MISSING. The browser today has no concept of a Fast-mode disabled reason — the
state machine collapses all six cases into a single hidden `"off"`. Worth
adding once the SDK exposes the reason field: thread it through the existing
`fast_mode_state` SSE message in `lib/server/session.ts` as a sibling
`fast_mode_disabled_reason`, store it on `use-session.ts`, and render it as a
small chip / tooltip next to the Fast mode toggle in `ModelPicker.tsx` so the
user sees "credits exhausted" vs "turned off by your organization" without
having to dig.
