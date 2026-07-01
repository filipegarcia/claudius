# Opus high-load /model Sonnet nudge

**Source:** Claude Code TUI — error & recovery
**Status:** ALREADY_EXISTS

## What it is
After repeated 529 Overloaded errors come back from Opus, the TUI surfaces a one-line nudge: `Opus is experiencing high load, please use /model to switch to Sonnet`. This is distinct from the automatic fallback notice — it's a manual nudge that asks the user to switch models themselves via `/model`.

## Claudius today
Wired end-to-end. `lib/server/opus-overload-detector.ts` classifies SDK messages (synthetic assistant `API Error: 529 … Overloaded` bodies and `result` messages with `subtype: "error_during_execution"`) and gates on `isOpusModelId`. `lib/server/session.ts` counts consecutive overload observations and emits an `OpusOverloadNudgeEvent` (declared in `lib/shared/events.ts`, consumed in `lib/client/use-session.ts`). `components/chat/OpusOverloadNudgePanel.tsx` renders the one-line banner with a "Switch to Sonnet" button targeting `OPUS_OVERLOAD_NUDGE_SONNET_TARGET` (`claude-sonnet-5`) and a dismiss control. Unit coverage in `tests/unit/opus-overload-detector.test.ts`.

## Decision
ALREADY_EXISTS. The detector + SSE event + banner mirror the TUI nudge faithfully, with a click-through that calls `setModel` on Sonnet rather than asking the user to type `/model` by hand. The event is live-only (skipped in the SSE replay buffer) and fire-once per session so it doesn't re-pop on reload.
