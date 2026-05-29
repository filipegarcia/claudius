# ANTHROPIC_API_KEY

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
The Anthropic API key used to authenticate the Claude API. When set, Claude Code uses it instead of OAuth credentials.

## Claudius today
Authentication is surfaced read-only on the Doctor page. `app/api/doctor/route.ts` (lines 85-109) checks `process.env.ANTHROPIC_API_KEY`, the `~/.claude/.credentials.json` OAuth file, and the Bedrock/Vertex/Foundry provider switches, then reports an "Auth" check ("ANTHROPIC_API_KEY set" / "OAuth credentials file present" / "No API key or OAuth credentials found"). The free-form Environment editor in Settings (`app/settings/page.tsx`, `EnvEditor`) can also write `ANTHROPIC_API_KEY` into settings.json's `env` block, which the SDK reads.

## Decision
ALREADY_EXISTS. Auth status is reported by `/doctor` (`app/api/doctor/route.ts`), and the key can be set via the Settings → Environment editor (`app/settings/page.tsx`). A secret-value input is intentionally read-as-status rather than echoed; this matches the existing quality bar (Claudius runs locally and inherits the shell/credentials, so it does not need to own the secret).
