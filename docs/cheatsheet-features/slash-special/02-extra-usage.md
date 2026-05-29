# /extra-usage

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** NOT_APPLICABLE

## What it is
`/extra-usage` lets a subscriber turn on paid overage ("extra usage") so work can
continue after a plan rate limit is reached — a hosted-account billing toggle tied
to the signed-in Anthropic subscription.

## Claudius today
Registered in `lib/shared/slash-commands.ts` (`id: "extra-usage"`, category
`cost`, `handler: "sdk"`). The *consequences* of rate limits are already surfaced
well in the browser: `components/chat/RateLimitHitPanel.tsx` renders an inline
panel under a hard-limit assistant message with a live reset countdown and
"Upgrade your plan / Upgrade to Team plan" links, and `components/chat/SystemPill.tsx`
carries the full set of extra-usage rejection reasons (`org_level_disabled`,
`seat_tier_zero_credit_limit`, etc.). The local `app/api/limits/` API is unrelated
— it manages per-project/per-session USD cost caps stored in `.claudius.db`, not
the hosted overage setting.

## Decision
NOT_APPLICABLE. Enabling extra usage flips a billing setting on the user's hosted
Anthropic account; there is no browser-side toggle Claudius can own without hosted
account-billing plumbing it doesn't have. The browser already does the
right-and-buildable part — it detects the rate-limit hit, explains why extra usage
is or isn't available (SystemPill reasons), counts down to reset, and links out to
the upgrade/extra-usage path (RateLimitHitPanel). The actual enable-overage action
stays hosted/CLI-only.
