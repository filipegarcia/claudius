# Opus 4 demand banner with inline /model switcher

**Source:** Claude Code TUI — error & recovery
**Status:** ALREADY_EXISTS

## What it is
When the Anthropic backend signals high demand specifically for Opus 4.x, the
CLI surfaces a banner that tells the user they can keep coding immediately by
switching to a different model with `/model`. The literal strings in the binary
read `"We are experiencing high demand for Opus 4."` and
`"To continue immediately, use /model to switch to ... and continue coding."`
— distinct from the generic 529 overload nudge.

## Claudius today
The dedicated `components/chat/OpusHighDemandPanel.tsx` renders an inline
amber banner — "Opus 4 is experiencing high demand" plus a `/model` hint —
sibling to `RateLimitHitPanel.tsx` and `OpusOverloadNudgePanel.tsx`. Detection
lives in `lib/client/use-session.ts` as `isOpusHighDemandText` /
`OPUS_HIGH_DEMAND_RE` (anchored on the literal `"high demand for Opus 4"`
substring so unrelated prose doesn't trip it), with the `opusHighDemand` flag
declared on `DisplayMessage` in `lib/client/types.ts`. `AssistantMessage.tsx`
renders the panel under any assistant bubble whose first text block matches.
The underlying fix paths are also wired: `Options.fallbackModel` auto-switches
through `lib/server/workspaces-store.ts` and `lib/server/session.ts`, and the
`/model` CTA opens the existing `components/panels/widgets/ModelPicker.tsx`
overlay. Unit coverage is in `tests/unit/opus-high-demand-detection.test.ts`.

## Decision
ALREADY_EXISTS. The Opus-4 high-demand signal is detected, the inline banner
renders on live + replay + paginated scrollback paths via `AssistantMessage`,
and the `/model` slash-command + `ModelPicker` already handle the actual
switch. No new UI needed.
