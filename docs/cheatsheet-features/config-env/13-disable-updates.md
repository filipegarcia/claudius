# DISABLE_UPDATES

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Blocks all of Claude Code's update paths (no auto-update, no update prompts).

## Claudius today
Claudius has its own self-update story (a git-checkout pull/rebuild flow, distinct from Claude Code's npm auto-update) with a full browser surface. The updater offers a "Disabled" mode ("No background checks at all.") in both the embedded Settings section (`components/updater/UpdaterSettingsSection.tsx`, MODE_OPTIONS, line 32) and the dedicated `/updater` page, backed by `lib/server/updater/scheduler.ts`. There is also a `CLAUDIUS_UPDATER_DISABLED=1` env gate (`lib/server/updater/scheduler.ts`, line 33).

## Decision
ALREADY_EXISTS. The equivalent control — turning off all update checks — is the updater's "Disabled" mode, available at `/updater` and in Settings → Self-update (`components/updater/UpdaterSettingsSection.tsx`). The env var maps onto an existing, better-than-env toggle; no new surface needed.
