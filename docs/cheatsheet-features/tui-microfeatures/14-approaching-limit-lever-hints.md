# 'Approaching usage limit' soft warning with /model and /effort levers

**Source:** Claude Code TUI — error & recovery
**Status:** ALREADY_EXISTS

## What it is
Before a five-hour or seven-day quota actually rejects, the TUI emits a soft
heads-up — `Approaching <limit>` / `You're close to your <limit>` /
`You've used <n>% of your <limit> · resets <time>` — and pairs it with
concrete remediation levers the user can pull right now: `try /model sonnet`
to burn down Opus, `try /effort medium` to step `high` / `xhigh` back,
`/usage-credits to request more`, and `/upgrade to keep using Claude Code`.
The status-line JSON also exposes the live `effort` block
(`"level": "low" | "medium" | "high" | "xhigh" | "max"`, only present when
the current model supports reasoning effort) so external status-line scripts
can render the same runway hint.

## Claudius today
`components/chat/SystemPill.tsx`'s `RateLimitPill` is the full equivalent.
For `allowed_warning` events it renders `Approaching <tierLabel>` /
`You've used <n>% of your <tierLabel>` with `· resets <clock>` plus a live
`mm:ss` countdown, gated by `lib/client/useRateLimitWarning.ts` and the
`components/settings/RateLimitWarningSection.tsx` preset chips. The soft
branch now also surfaces both lever chips via `SystemPillLevers`: a
`try /model sonnet` chip when the active model contains "opus" and a
`try /effort medium` chip when the current effort is one of
`HIGH_EFFORT_LEVELS = {"high", "xhigh", "max"}` — both wired in
`app/[workspaceId]/page.tsx` to `session.setModel(...)` /
`session.setEffort("medium")` through `app/api/sessions/[id]/model/route.ts`
and `app/api/sessions/[id]/effort/route.ts`. The hard-stop `/upgrade`
affordance lives in `components/chat/RateLimitHitPanel.tsx`
(`UPGRADE_PLAN_URL` / `UPGRADE_TEAM_URL`, shared via `RateLimitUpgradeLinks`).
The `/usage-credits` ask-for-more flow maps to the registered
`/extra-usage` slash command in `lib/shared/slash-commands.ts` (alongside
`/usage` for the account page), and the status-line `effort.level` is
plumbed through `lib/server/session.ts` → `lib/client/use-session.ts` and
read by `components/chat/StatusLine.tsx`.

## Decision
ALREADY_EXISTS. The "Approaching `<limit>` · resets `<time>`" headline,
utilization readout, live countdown, hard-stop upgrade links, and both
`try /model sonnet` / `try /effort medium` remediation chips are all
shipped in `RateLimitPill` and its callers, with `/extra-usage` covering
the `/usage-credits` ask. No new UI needed.
