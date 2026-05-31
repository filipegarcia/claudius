# 'ultrathink' prose keyword injects deeper-reasoning reminder

**Source:** Claude Code TUI — input keyword nudge
**Status:** MISSING

## What it is
When the user prompt contains the substring `ultrathink`, the TUI injects a per-turn system-reminder that lifts the reasoning budget for just that turn:

> The user included the keyword "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.

Distinct from `/effort max` because it is a transient single-turn bump triggered by a word in prose, not a config change. Grounded in the `\bultrathink\b` regex, `ultrathink_effort`, `tengu_ultrathink`, and `ultrathink-active` identifiers present alongside the reminder string in the CLI binary.

## Claudius today
Not surfaced in Claudius. There is no prose-keyword scanner on the outgoing user prompt and no per-turn system-reminder injection path — `lib/shared/user-prompt.ts` and the SSE event flow in `lib/shared/events.ts` pass the prompt through verbatim to `query.input` in `lib/server/session.ts`. The closest browser equivalent is the Max chip in `components/panels/widgets/ModelPicker.tsx` posting to `app/api/sessions/[id]/effort/route.ts`, but that is a sticky config change, not a one-shot keyword bump. A natural home for the equivalent would be a small pre-send hook in `lib/server/session.ts` (or the composer in `components/chat/`) that detects `\bultrathink\b` and bumps effort for the next turn only.

## Decision
MISSING. The "max effort" outcome is reachable via `ModelPicker` (see `workflows-tips/05-ultrathink-max-effort.md`), but the TUI-specific behavior — prose-keyword detection that injects a transient per-turn reminder without touching the persistent effort config — has no analogue in Claudius. Worth adding only if users want to keep their sticky effort low while occasionally one-shotting a deeper turn from the composer; otherwise the existing Max chip covers the practical case.
