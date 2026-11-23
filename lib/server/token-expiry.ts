/**
 * Pure detection helper for the "your login is about to expire" nudge (CC
 * 2.1.203 parity: "Added a warning when your login is about to expire, so
 * you can re-authenticate before background sessions are interrupted").
 *
 * Claudius's account-switcher profiles (`AccountProfile.expiresAt`, see
 * `accounts-store.ts`) usually never carry an expiry — the `oauth-token`
 * kind is the long-lived `setup-token`-style credential, and Claudius never
 * refreshes it. But when the token-exchange response DOES report one and
 * nothing renews it, the credential eventually 401s — the same failure
 * `auth-failed-detector.ts` already handles *reactively*. This module is the
 * *proactive* counterpart: `Session.noteTokenExpiringAtStartup()` (in
 * `session.ts`) reads the active profile's `expiresAt` at session start and
 * uses `shouldWarnTokenExpiring()` to decide whether to fire the nudge.
 *
 * Kept dependency-light and pure (no `Date.now()` call baked in — the
 * caller passes `now`) so it's trivially unit-testable, mirroring
 * `opus-overload-detector.ts` / `isAuthFailedErrorText`.
 */

/**
 * How far ahead of an expiry we start warning. This was originally a
 * documented assumption (see the 2.1.204 run-notes "Risks / follow-ups"),
 * since Claude Code didn't document its own threshold at the time: warn
 * once under a day remains, which comfortably covers an overnight-idle
 * background session without nagging on every session start for a token
 * that's merely "not indefinite."
 *
 * CC 2.1.217 ("Changed the login-expiry warning to appear 3 days before
 * expiry instead of 5") revealed the CLI's own threshold is day-denominated
 * and was tightened from 5 days to 3. Adopting the now-known 3-day value
 * here replaces the earlier 24h guess with real parity, while keeping the
 * same "warn once, close to expiry" intent for Claudius's mostly-long-lived
 * oauth-token profiles.
 */
export const TOKEN_EXPIRY_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * True iff `expiresAt` is a real future timestamp that falls inside the
 * warning window. Returns false for:
 *   - `undefined`/`null` (no expiry known — the common case for Claudius's
 *     long-lived oauth-token profiles),
 *   - a timestamp already in the past (that's `auth-failed-detector.ts`'s
 *     job — a stale nudge for an already-dead token would be confusing), and
 *   - a timestamp further out than the warning window (nothing to say yet).
 */
export function shouldWarnTokenExpiring(
  expiresAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  const remaining = expiresAt - now;
  return remaining > 0 && remaining <= TOKEN_EXPIRY_WARNING_WINDOW_MS;
}

/**
 * CC 2.1.318 parity — "Added the date a stored claude.ai sign-in ends to …
 * `claude -p` JSON results (`credential_expires_at`)" and "Added a one-line
 * stderr warning to `claude -p` text output, starting 10 days before a stored
 * claude.ai sign-in ends". Claudius's sessions are stream-json, so that
 * stderr line never reaches the chat, and the access-token nudge above only
 * knows about account-switcher profiles — a plain `claude /login` keychain
 * sign-in had no warning at all. The SDK now stamps the sign-in's end on every
 * `result`; this is the engine's 10-day window for it.
 */
export const SIGN_IN_END_WARNING_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * The sign-in end (Unix ms) to warn about, or null. `credentialExpiresAt` is
 * the result's ISO `credential_expires_at`. Null when absent / unparseable,
 * already past (that's the reactive auth-failed path — the SDK says a past
 * date means "probably ended", not that it has), or more than 10 days out.
 */
export function signInEndToWarn(credentialExpiresAt: unknown, now: number): number | null {
  if (typeof credentialExpiresAt !== "string" || !credentialExpiresAt) return null;
  const at = Date.parse(credentialExpiresAt);
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  return remaining > 0 && remaining <= SIGN_IN_END_WARNING_WINDOW_MS ? at : null;
}
