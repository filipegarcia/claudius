# Opus 4 demand banner with inline /model switcher

**Source:** Claude Code TUI — error & recovery
**Status:** PARTIAL

## What it is
When the Anthropic backend signals high demand specifically for Opus 4.x, the
CLI surfaces a banner that tells the user they can keep coding immediately by
switching to a different model with `/model`. The literal strings in the binary
read `"We are experiencing high demand for Opus 4."` and
`"To continue immediately, use /model to switch to ... and continue coding."`
— distinct from the generic 529 overload nudge.

## Claudius today
The recovery affordance is split across two surfaces but no Opus-specific
banner exists. The SDK's automatic fallback is wired through
`lib/server/workspaces-store.ts` (lines 23-27, `fallbackModel` →
`Options.fallbackModel`, "switches to this when the primary model is
unavailable or errors (e.g. overload, model_not_found)") and applied per
session in `lib/server/session.ts` (lines 320-323, 718-721). Manual model
switching is the `ModelPicker` overlay
(`components/panels/widgets/ModelPicker.tsx`) on the SessionCard, backed by
`app/api/sessions/[id]/model/route.ts`. Hard rate-limit hits get a dedicated
inline panel (`components/chat/RateLimitHitPanel.tsx`) with countdown + upgrade
links, but there is no Opus-demand variant — the "high demand for Opus 4"
message would surface only as raw assistant prose, with no inline /model CTA
attached.

## Decision
PARTIAL. The underlying fix paths exist — `fallbackModel` auto-switches and
`ModelPicker` lets the user switch manually — but the targeted "Opus 4 is
under demand, use /model now" banner is not detected or surfaced. Worth adding
as a `components/chat/`-level banner (sibling to `RateLimitHitPanel.tsx`) that
fires on the Opus-demand signal and pops the `ModelPicker` on click, if the
user wants this surfaced as a discrete CTA rather than buried in assistant
text.
