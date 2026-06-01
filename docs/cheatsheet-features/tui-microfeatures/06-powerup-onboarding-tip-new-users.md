# /powerup interactive tutorial nudge (new users)

**Source:** Claude Code TUI — tip rotation (onboarding-gated)
**Status:** ALREADY_EXISTS

## What it is
A new-user-only spinner tip that points at `/powerup` for a quick interactive
tutorial. The TUI registers it as `"powerup-onboarding",priority:3,...content:
...`New to Claude Code? Run ${...("/powerup")} for a quick interactive tutorial`,
cooldownSessions:1` and gates it on `numStartups<10`, no `powerupsUnlocked`,
plus the Statsig flag `tengu_alder_compass`. So it surfaces only for the first
~10 launches, only before the user has unlocked any powerups, and only when the
flag is on.

## Claudius today
Mirrored end-to-end. `lib/shared/tips.ts` includes a `DEFAULT_TIPS` entry with
`id: "powerup-onboarding"`, `text: "New to Claudius? Run /powerup for a quick
interactive tutorial."`, and `requiresNewUser: true`. `selectClientTips()` in
the same file drops any tip whose `requiresNewUser` is true unless the caller
passes `newUser`, and `app/[workspaceId]/page.tsx` derives that boolean from
`lib/client/useStartupCount.ts` — a per-browser launch counter (localStorage,
`useSyncExternalStore`, bumped once per page load) that's the direct analog of
the TUI's `numStartups`, with the same `< 10` threshold. The `/powerup` command
itself is registered in `lib/shared/slash-commands.ts` as `{ id: "powerup", …,
description: "Animated feature lessons.", handler: "external" }` so the tip text
names the command but doesn't try to invoke it (clicking would just toast
"terminal/hosted only"). The TUI's `cooldownSessions:1` and `powerupsUnlocked`
gates are intentionally not mirrored — the inline comment on the tip notes that
Claudius's `DISMISSED_TIP_SHOW_PROBABILITY` dismiss-weighting covers the same
"show less, not never" intent, and `/powerup` being external means we can't
observe engagement to drive a `powerupsUnlocked` equivalent. The Statsig
`tengu_alder_compass` flag has no Claudius analog by design.

## Decision
ALREADY_EXISTS. The first-run nudge surfaces through the existing spinner-tip
rotation with the same `< 10` launch gate as the TUI; no new banner or
component is needed. If we ever want to harden this further, the next move
would be a `powerupsUnlocked`-style gate keyed on whether the user has actually
opened `/powerup` (or its hosted equivalent) — but that only matters once
Claudius gains a first-party powerup surface.
