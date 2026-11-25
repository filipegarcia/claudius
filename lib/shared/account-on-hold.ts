/**
 * CC 2.1.330 — "[VSCode] Fixed signing in to an account on hold showing a
 * generic failure instead of the on-hold notice and appeal link".
 *
 * Ports of the engine's pieces (2.1.332 bundle), wording included:
 *  - the token endpoint's on-hold answer: `error` `invalid_grant` or
 *    `access_denied`, `error_description` `account_on_hold`, an optional
 *    string `error_uri` (`k2o`);
 *  - the appeal link: `error_uri` only when it's a plain https URL on
 *    claude.ai or anthropic.com (or a subdomain), else
 *    https://claude.ai/restricted (`uot`);
 *  - the sign-in notice, with the `TS-…` reference when the link carries
 *    one (`w2o`).
 *
 * Shared so the server builds the notice and the client can check a link
 * before rendering it.
 */

export const ACCOUNT_RESTRICTED_URL = "https://claude.ai/restricted";

const MAX_URL_LENGTH = 2048;
const APPEAL_URL_RE = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9/._~%-]*(?:\?[A-Za-z0-9._~%=&-]*)?(?<![.?])$/;
const REFERENCE_RE = /[?&]ref=(TS-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:&|$)/;

/** The link the notice may show for `raw` (an `error_uri`), or the restricted page. */
export function accountOnHoldAppealUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return ACCOUNT_RESTRICTED_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ACCOUNT_RESTRICTED_URL;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return ACCOUNT_RESTRICTED_URL;
  const host = url.hostname;
  const allowed =
    host === "claude.ai" || host.endsWith(".claude.ai") || host === "anthropic.com" || host.endsWith(".anthropic.com");
  return allowed && url.href.length <= MAX_URL_LENGTH && APPEAL_URL_RE.test(url.href) ? url.href : ACCOUNT_RESTRICTED_URL;
}

/** The engine's sign-in notice for an on-hold account. */
export function accountOnHoldSignInNotice(appealUrl: string): string {
  const notice = `Your account is on hold and can't sign in to Claude Code. View details or appeal: ${appealUrl}`;
  const reference = REFERENCE_RE.exec(appealUrl)?.[1];
  return reference ? `${notice} (Reference: ${reference})` : notice;
}

/** The appeal link when a token-endpoint error body says the account is on hold, else null. */
export function accountOnHoldFromTokenError(bodyText: string): { appealUrl: string } | null {
  if (!bodyText.includes("account_on_hold")) return null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { error, error_description, error_uri } = body as Record<string, unknown>;
  if (error !== "invalid_grant" && error !== "access_denied") return null;
  if (error_description !== "account_on_hold") return null;
  if (error_uri !== undefined && typeof error_uri !== "string") return null;
  return { appealUrl: accountOnHoldAppealUrl(error_uri) };
}
