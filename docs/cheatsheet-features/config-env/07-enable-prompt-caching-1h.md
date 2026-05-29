# ENABLE_PROMPT_CACHING_1H

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Opts the prompt cache into the 1-hour TTL instead of the default 5-minute TTL — an internal API-billing/performance knob.

## Claudius today
No dedicated surface. Prompt-cache TTL is an SDK/API-internal behavior with no corresponding setting in the SDK's `Settings` interface and no Claudius UI. It is set purely via the env var, which (like any env var) can be entered in the Settings → Environment editor (`app/settings/page.tsx`) but has no observable browser behavior to drive a dedicated control.

## Decision
NOT_APPLICABLE. This is a pure billing/performance env var with no user-visible browser behavior to expose. Cache TTL is invisible in the chat UI and not a settings.json key, so a dedicated control would be a toggle no user could verify or reason about. It remains reachable (without value) through the generic Environment editor.
