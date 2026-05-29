# ANTHROPIC_BASE_URL

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Overrides the Anthropic API base URL so traffic routes through a proxy or gateway (LLM gateway, corporate egress proxy, self-hosted relay).

## Claudius today
There is no dedicated proxy field, but the Settings → Environment editor (`app/settings/page.tsx`, the `EnvEditor` widget, surfaced via the "Environment" section at line 482) is a generic KEY/value editor that writes into settings.json's `env` block. Claude Code / the SDK reads `env` natively, so `ANTHROPIC_BASE_URL` (and the related `HTTP_PROXY`/`HTTPS_PROXY`) can be set there per scope (User/Project/Local).

## Decision
ALREADY_EXISTS via the generic Environment editor in Settings (`app/settings/page.tsx`). A purpose-built "proxy / gateway" field is not warranted — it is a single string env var with no behavior beyond what the env editor already provides, and the catalog of named fields deliberately omits raw connection plumbing.
