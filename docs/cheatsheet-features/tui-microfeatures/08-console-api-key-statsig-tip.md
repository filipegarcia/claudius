# Console API-key nudge (Statsig-gated)

**Source:** Claude Code TUI — tip rotation
**Status:** MISSING

## What it is
A targeted tip pitching `/claude-api` to logged-in users who don't yet have a primary API key, haven't approved any custom keys, have no `ANTHROPIC_API_KEY` in env, have launched the CLI more than 10 times, and only when the Statsig flag `tengu_kestrel_arch` is `"on"`. The tip text is `Build your AI product with Claude API. Run /claude-api to get started` with `cooldownSessions:15`, gated by `isRelevant` checks that include `H.numStartups<=10` and `L_("tengu_kestrel_arch","off")==="on"`.

## Claudius today
Not surfaced in Claudius. The rotating-tip catalog in `lib/shared/tips.ts` is a flat, per-session round-robin with no per-tip `isRelevant`/cooldown/remote-flag gating, and no signals for login state, primary API key, approved custom-key history, `numStartups`, or Statsig. `/claude-api` exists as an SDK skill in `lib/shared/slash-commands.ts` (line 166), but nothing nudges users toward it. A natural home would be a new conditional `Tip` in `lib/shared/tips.ts` plus an `isRelevant` hook on `selectTips()` reading from a server-side feature-flag/account-state source.

## Decision
MISSING. The infrastructure to support this (per-tip relevance predicates, per-tip cooldown across sessions, remote feature flags, and account-state signals like `numStartups` / `primaryApiKey` / `customApiKeyResponses`) doesn't exist in Claudius today, and the specific `/claude-api` nudge isn't shown anywhere. Worth adding only if Claudius gains its own remote-config layer and account-state telemetry; otherwise this is a Console-acquisition tip that doesn't map onto the browser surface.
