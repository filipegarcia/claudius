# CLAUDE_CODE_ENABLE_AWAY_SUMMARY

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Forces Claude Code to generate an "away" recap (a catch-up summary of what happened while you were gone) even when telemetry is disabled.

## Claudius today
Claudius already keeps the user oriented when away through its own mechanisms: the in-app notification feed / desktop notifications (`lib/server/notification-bus.ts`, `lib/client/useNotifications.ts`), session-idle background notifications, and the sticky `RecapBanner` (`components/chat/RecapBanner.tsx`) that names the session. Notably, the SDK intercepts `/recap` as a local command and never produces an assistant response, so the richer Goal/Done/Next recap layer is explicitly deferred (documented in `RecapBanner.tsx`, lines 36-39).

## Decision
NOT_APPLICABLE. This is a CLI telemetry-coupling flag (force a recap when telemetry is off) with no analogue in a browser app that already surfaces activity via the notification feed and session banners. The underlying SDK `/recap` is a local command that produces no response, so there is no recap payload to gate on — building UI around this flag would have no backend to render. (If a structured Goal/Done/Next recap is ever wanted, that is a separate deferred feature needing new SDK plumbing, not this env var.)
