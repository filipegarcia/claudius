# Multi-Claude color/rename nudge

**Source:** Claude Code TUI — tip rotation (conditional)
**Status:** ALREADY_EXISTS

## What it is
A spinner tip that fires only once the user has 2+ Claude Code sessions
running concurrently, suggesting `/color` and `/rename` so they can tell
sessions apart at a glance. The grounded evidence shows the tip object gated
by `isRelevant: async () => await wo_() >= 2` with a 10-session cooldown:
> Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.

## Claudius today
The exact tip is registered in `lib/shared/tips.ts` as the
`multi-claude-color-rename` entry (text: "Running multiple Claude sessions?
Use /color and /rename to tell them apart at a glance.", `minSessions: 2`).
The threshold gate is enforced by `selectClientTips` in the same file
(`(t.minSessions ?? 0) > activeSessionCount` → filtered out), with the caller
in `app/[workspaceId]/page.tsx` passing `openTabs.length` as
`activeSessionCount` — the direct mirror of the TUI's `wo_() >= 2`. The tip
is intentionally command-less because `/color` is SDK-handled and `/rename`
is destructive (filtered by `tests/unit/tips.test.ts`); the text names them
so the user runs them themselves. The TUI's `cooldownSessions:10` is covered
by Claudius's dismiss-weighting (`DISMISSED_TIP_SHOW_PROBABILITY`) rather
than a session counter. The destinations themselves are also in place:
`/rename` is a native command surfaced via
`components/overlays/RenameOverlay.tsx`, `/color` is SDK-handled, and
`components/chat/SessionTabs.tsx` already renders per-session labels and
status dots so the suggested commands have somewhere visible to land.

## Decision
ALREADY_EXISTS. The conditional tip, the 2+ session gate, and the
`/color` + `/rename` destinations are all wired up. No new UI needed.
