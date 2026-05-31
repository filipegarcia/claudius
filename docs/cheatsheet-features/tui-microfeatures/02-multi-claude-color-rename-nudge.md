# Multi-Claude color/rename nudge

**Source:** Claude Code TUI — tip rotation (conditional)
**Status:** PARTIAL

## What it is
A conditional spinner tip that fires only once the user has 2+ Claude Code
sessions running concurrently, suggesting `/color` and `/rename` so they can
tell sessions apart at a glance. The grounded evidence shows the tip object
gated by `isRelevant: async () => await wo_() >= 2` with a 10-session
cooldown:
> Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.

## Claudius today
The two underlying commands both exist: `/rename` is a native, session-scoped
command registered in `lib/shared/slash-commands.ts` (handled by the chat
page's native dispatcher and surfaced via `components/overlays/RenameOverlay.tsx`),
and `/color` is registered as an SDK-handled command in the same file. Multiple
concurrent sessions are already a first-class concept in the browser:
`components/chat/SessionTabs.tsx` renders a per-session tab strip with custom
labels, status dots, and unread badges, and `components/chat/SessionPicker.tsx`
offers a switcher. The conditional spinner-tip nudge itself, however, does not
exist — `components/chat/SpinnerTip.tsx` rotates the static `DEFAULT_TIPS` from
`lib/shared/tips.ts` with no `isRelevant`/cooldown gating, and none of the
default tips mention `/color` or `/rename` (the latter is filtered out by
`tests/unit/tips.test.ts` as a destructive command unsafe to click mid-turn).

## Decision
PARTIAL. The destinations (`/color`, `/rename`) and the multi-session UX
(SessionTabs labels, status, badges) are already in place, so the user can
already tell sessions apart — but the just-in-time spinner nudge that fires
once 2+ sessions are concurrent is not implemented. Worth adding as a
conditional tip variant in `lib/shared/tips.ts` (extend `Tip` with an
`isRelevant` predicate and a cooldown counter, fed by the active-session count
already tracked client-side) if we want the same "you've crossed a threshold,
here's the trick" affordance in `SpinnerTip`.
