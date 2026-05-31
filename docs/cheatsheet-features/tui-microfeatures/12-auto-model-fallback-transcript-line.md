# Automatic model-fallback system message

**Source:** Claude Code TUI — model state
**Status:** PARTIAL

## What it is
When the requested model isn't available because of demand, Claude Code
auto-switches to the configured fallback and prints a one-line system message
into the transcript. The binary fragments stitch together as
`Switched to <new> because <old> is not available due to high demand for <old>`,
emitted alongside the `tengu_model_fallback_triggered` telemetry event. It is
distinct from the manual `/model` switcher confirmation — this line fires
automatically, without user input, the moment the SDK swaps in `fallbackModel`.

## Claudius today
The fallback *mechanism* is fully plumbed but the transcript announcement is
not. `lib/server/workspaces-store.ts` (lines 23-27) and `lib/server/session.ts`
(lines 320-323, 718-721) wire `fallbackModel` straight into the SDK's
`Options.fallbackModel`, "[which] switches to this when the primary model is
unavailable or errors (e.g. overload, model_not_found)"; the field is exposed in
the workspace form (`components/workspaces/WorkspaceForm.tsx` lines 72-74,
509-…) and accepted per-request by `app/api/sessions/route.ts`. What is missing
is the transcript marker: `components/chat/SystemPill.tsx` has kinds for
`init`, `status`, `rate_limit`, `api_retry`, `compact_boundary`, etc., but no
`model_fallback` kind, and `lib/client/sdk-message-filters.ts` does not lift
the fallback event into a typed `SystemEntry`. If the SDK emits the swap as a
synthetic assistant/system message, it renders as untyped prose; if it emits a
custom event, Claudius drops it.

## Decision
PARTIAL. The SDK does the swap correctly (the option flows through), but the
moment-of-swap is invisible in the Claudius transcript — the user only finds
out by spotting that the model badge changed on the SessionCard. Worth adding
a `model_fallback` `SystemEntry` kind (icon: `Cpu` / tone amber, mirroring
the existing `init` and `rate_limit` pills) and lifting the SDK's
`model_fallback_triggered`-shaped event in `lib/client/sdk-message-filters.ts`,
so the "Switched to X because Y is not available due to high demand for Y" line
appears in-thread the way it does in the CLI.
