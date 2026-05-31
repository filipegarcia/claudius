# /powerup interactive tutorial nudge (new users)

**Source:** Claude Code TUI — tip rotation (onboarding-gated)
**Status:** MISSING

## What it is
A new-user-only tip that points at `/powerup` for a quick interactive tutorial. The TUI registers it as `> "powerup-onboarding",priority:3,...content:...`New to Claude Code? Run ${...("/powerup")} for a quick interactive tutorial`,cooldownSessions:1` and gates it on `numStartups<10`, no `powerupsUnlocked`, plus the Statsig flag `tengu_alder_compass`. So it surfaces only for the first ~10 launches, only before the user has unlocked any powerups, and only when the flag is on.

## Claudius today
Not surfaced in Claudius. `/powerup` itself is registered as an `external` command in `lib/shared/slash-commands.ts` (`{ id: "powerup", ..., description: "Animated feature lessons.", handler: "external" }`), but the generic tip rotation in `lib/shared/tips.ts` is unconditional (no `numStartups`/`powerupsUnlocked` gating) and doesn't include a powerup entry; there is no first-run nudge anywhere in `components/welcome/WelcomeSplash.tsx` or the chat composer that points new users at it. It would naturally live as a new entry in `DEFAULT_TIPS` (or a dedicated onboarding banner above the composer) gated by a session-count counter persisted in the workspace store.

## Decision
MISSING. The `/powerup` command exists in Claudius's command catalog but the onboarding nudge that drives discovery of it in the CLI has no analog in the browser. Worth adding as either a one-shot first-run tip in `lib/shared/tips.ts` (with a `numStartups`-style gate read from a new counter) or a dismissible banner in `components/chat/`, if the user wants this surfaced.
