# 1M-context credit-required hint with /model fallback path

**Source:** Claude Code TUI — error & recovery
**Status:** ALREADY_EXISTS

## What it is
When the user asks for a 1M-context model without usage credits, the TUI prints `Extra usage is required for long context` and offers two concrete remediation routes: `run /usage-credits to turn them on, or /model to switch to standard context`. The hint pairs a precise diagnosis with both a billing-side fix (`/usage-credits`) and a same-session fallback (`/model`) so the user is never stuck.

## Claudius today
Fully surfaced. `lib/server/long-context-credits-detector.ts` recognizes the SDK's structured `billing_error` on assistant messages, and `lib/server/session.ts` (`noteLongContextCreditsObservation`, fired from the message loop around line 4270) gates the nudge to sessions running with the 1M-context beta and fires it once per session lifetime. The event flows through `lib/shared/events.ts` (`LongContextCreditsNudgeEvent`) and `lib/client/use-session.ts` to `components/chat/LongContextCreditsPanel.tsx`, which mirrors the TUI copy: "Extra usage is required for long context", a link to `https://claude.ai/settings/usage` (the `/usage-credits` route), and a "Switch model" button that opens the model picker in `components/panels/widgets/ModelPicker.tsx` (the `/model` fallback). Wired into the chat shell in `app/[workspaceId]/page.tsx` (around line 1413). Unit-tested in `tests/unit/long-context-credits-detector.test.ts`.

## Decision
ALREADY_EXISTS. Both remediation routes are present: the billing link (claude.ai/settings/usage, matching `/usage-credits`) and the model-picker fallback (matching `/model`), gated to the 1M-context beta to avoid doubling up with the rate-limit `overageDisabledReason` copy in `SystemPill`. No new UI required.
