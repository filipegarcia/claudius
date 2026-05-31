#  'Now using <fallback model>' weekly-limit takeover toast

**Source:** Claude Code TUI — ambient status line
**Status:** PARTIAL

## What it is
When a per-model weekly limit fires (`seven_day_opus` / `seven_day_sonnet`), the TUI prints an ambient line so the user knows why the active model just silently changed: `Now using <fallback>. Your <limit> resets <time>`. The strings `Now using `, ` Your `, ` resets `, `You're now using `, and `You've hit your ` appear consecutively in the binary, adjacent to the `seven_day_opus`/`seven_day_sonnet` keys and the `anthropic-ratelimit-unified-*` headers — confirming this is the fallback-takeover toast that pairs with the weekly-limit rejection.

## Claudius today
Claudius surfaces the weekly-limit hit itself but not the "now using fallback" takeover line. `components/chat/RateLimitHitPanel.tsx` and the `RateLimitPill` in `components/chat/SystemPill.tsx` label `seven_day_opus` / `seven_day_sonnet` as `weekly Opus limit` / `weekly Sonnet limit` with a live countdown to reset, and `tests/unit/rate-limit-hit-detection.test.ts` covers the detector (`lib/client/use-session.ts` around line 116). The fallback model is plumbed end-to-end — `Session.fallbackModel` in `lib/server/session.ts` (forwarded to the SDK at line 721), the `fallbackModel` field on `SessionConfigEvent` in `lib/shared/events.ts`, the workspace-default field in `components/workspaces/WorkspaceForm.tsx`, and the `/api/sessions` request body — so the SDK switches models, but Claudius never tells the user "you're now using X because Y": there's no event listener that pairs the model change with the weekly-limit reason and emits a "Now using <fallback>" status line.

## Decision
PARTIAL. The weekly-limit detection, the type labels, the reset countdown, and the `fallbackModel` config all exist; the takeover toast that explains the silent model change does not. Worth folding into `components/chat/RateLimitHitPanel.tsx` (or the `RateLimitPill` in `components/chat/SystemPill.tsx`) — when `rateLimitType` is `seven_day_opus` / `seven_day_sonnet` and the session has a `fallbackModel`, append "Now using <fallback>" so the user understands why the next turn comes back on a different model.
