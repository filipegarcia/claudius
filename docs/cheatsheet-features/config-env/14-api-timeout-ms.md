# API_TIMEOUT_MS

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Sets the API request timeout in milliseconds (default 600000 / 10 minutes).

## Claudius today
There is no dedicated timeout field, but the Settings → Environment editor (`app/settings/page.tsx`, the `EnvEditor` widget under the "Environment" section, line 482) writes arbitrary keys into settings.json's `env` block, which the SDK reads. `API_TIMEOUT_MS` can be set there per scope. It is a single integer env var with a sensible default and no per-session UX value.

## Decision
ALREADY_EXISTS via the generic Environment editor in Settings (`app/settings/page.tsx`). A dedicated numeric field is not warranted — it is a rarely-touched advanced env var with a working default, and the env editor already covers the set-it-once case without cluttering the settings catalog.
