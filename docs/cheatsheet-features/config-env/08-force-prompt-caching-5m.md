# FORCE_PROMPT_CACHING_5M

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Forces the 5-minute prompt-cache TTL — the counterpart to `ENABLE_PROMPT_CACHING_1H`, again an internal API-billing/performance knob.

## Claudius today
No dedicated surface, for the same reason as the 1h variant: prompt-cache TTL is an SDK/API-internal behavior with no settings.json key and no observable browser effect. It can be entered as a raw key in the Settings → Environment editor (`app/settings/page.tsx`) but does not warrant a labeled control.

## Decision
NOT_APPLICABLE. Pure billing/performance env var with no user-visible behavior in the browser. There is nothing for a UI to show or verify, so no dedicated surface is justified; the generic Environment editor covers the env-setting case.
