# Opus high-load /model Sonnet nudge

**Source:** Claude Code TUI — error & recovery
**Status:** MISSING

## What it is
After repeated 529 Overloaded errors come back from Opus, the TUI surfaces a one-line nudge: `Opus is experiencing high load, please use /model to switch to Sonnet`. This is distinct from the automatic fallback notice — it's a manual nudge that asks the user to switch models themselves via `/model`.

## Claudius today
Not surfaced in Claudius. The SDK-driven automatic fallback path is wired through `lib/server/session.ts` (`fallbackModel` is passed when set), and `components/panels/widgets/ModelPicker.tsx` already lets the user pick Sonnet — but there is no detector for repeated 529 overload errors and no banner that prompts a manual switch. It would naturally live as a transient banner in `components/chat/` (alongside `RateLimitHitPanel.tsx`), triggered by a counter in `lib/server/session.ts` that watches for repeated overload errors and emits an SSE event consumed by `lib/client/use-session.ts`.

## Decision
MISSING. Worth adding as a one-line banner in `components/chat/` (mirroring `RateLimitHitPanel.tsx`) that fires after N consecutive 529s from Opus, with a click-through that opens the existing `ModelPicker` on Sonnet — useful enough during Opus overload events that a manual nudge complements the SDK's automatic fallback.
