/**
 * Canonical "usage limit genuinely reached" prose prefixes, mirrored from the
 * SDK's `USAGE_LIMIT_ERROR_PREFIXES` (`@alpha`, added in
 * `@anthropic-ai/claude-agent-sdk` 0.3.211 — see
 * `.claudius/sdk-updater/run-notes/0.3.211.md`).
 *
 * # Why a literal copy instead of importing the SDK export directly
 *
 * The SDK's main entry (`sdk.mjs`) is a single Node-only bundle — importing
 * *any* value (not just a type) from `@anthropic-ai/claude-agent-sdk` pulls
 * the whole thing (child_process, fs, …) into whatever bundle references it.
 * `lib/shared/` is imported from both `lib/client/` (browser bundle) and
 * `lib/server/`, so a value import here would break the client build. The
 * SDK also ships a `./browser` sub-export, but it does NOT re-export these
 * prefix consts (checked against 0.3.211's `browser-sdk.js`).
 *
 * So this file holds a hand-copied literal — exactly the "hand-mirrored
 * list" the SDK's `@alpha` export was meant to obsolete. The risk is
 * silent drift on a future SDK bump. That risk is closed by
 * `tests/unit/rate-limit-prefixes-sdk-sync.test.ts`, which imports the real
 * `USAGE_LIMIT_ERROR_PREFIXES` from the SDK (fine there — vitest runs under
 * Node) and asserts exact equality against the copy below. If upstream
 * changes the list, that test fails loudly instead of the copy quietly
 * going stale.
 *
 * # Why only `USAGE_LIMIT_ERROR_PREFIXES` of the four sibling exports
 *
 * The SDK also exports `USAGE_TRANSITION_PREFIXES`, `USAGE_WARNING_PREFIXES`,
 * and `ORG_POLICY_LIMIT_PREFIXES` (all `@alpha`, same release). Claudius has
 * no existing prose detector for any of those three — they're toast/footer
 * only upstream (transition, warning) or would require a new "org disabled"
 * UI surface we don't have (org-policy) — so there's no hand-mirrored logic
 * to converge onto them. Only `USAGE_LIMIT_ERROR_PREFIXES` has a real call
 * site (`isRateLimitHitText` / `isRateLimitHitSdkMessage`), so only it is
 * copied here.
 */
export const USAGE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
] as const;

/**
 * True when `text` is (the start of) one of the CLI's "you've genuinely hit
 * a usage limit" prose templates — the replacement for the old
 * `RATE_LIMIT_HIT_TEXT_RE` regex that only recognized the single "You've hit
 * your … limit" phrasing and missed the other 11 templates the CLI actually
 * emits (credits exhausted, org out of usage, seat-type restrictions, …).
 *
 * Normalizes curly apostrophes (’) to straight (') and compares
 * case-insensitively before doing a prefix match, since the CLI's own
 * rendering has been observed with both apostrophe forms (see the existing
 * `rate-limit-hit-detection` test fixtures).
 */
export function matchesUsageLimitPrefix(text: string): boolean {
  const normalized = text.trim().replace(/[‘’]/g, "'").toLowerCase();
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}
