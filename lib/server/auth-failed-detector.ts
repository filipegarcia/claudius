/**
 * Detect whether an SDK message (or a thrown-error message string) carries
 * an *authentication failure* — i.e. the Anthropic API rejected the request
 * with HTTP 401 because the active credential is invalid / expired. Used by
 * `Session` to surface a one-shot "open the accounts section to fix your
 * credential" nudge in the chat — mirror of the Claude Code TUI's "Please
 * run /login" hint, scoped to Claudius's browser-side accounts UI.
 *
 * Pure + dependency-light so the matching is unit-testable. Same shape as
 * `opus-overload-detector.ts`: BOTH the structured signal (the SDK's
 * `SDKAssistantMessageError = 'authentication_failed'` enum tag on the
 * assistant envelope) AND a text fallback for the synthetic "API Error:
 * 401 … authentication" assistant body that the SDK emits when the auth
 * failure surfaces before any structured error field is populated.
 * `oauth_org_not_allowed` is intentionally NOT matched here — it's a
 * different remediation (the account is fine, the org just isn't on the
 * allow-list) and routing it to "open accounts" would mislead.
 */

/**
 * True when `text` looks like an authentication-side 401 from Anthropic.
 * Anchored on BOTH the status code and the word "authenticat" so a bare
 * "401" inside an unrelated payload (a uuid fragment, a port number)
 * doesn't false-match. Mirror of `isOverloadErrorText`'s defensive pattern.
 */
export function isAuthFailedErrorText(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // The bare phrase "failed to authenticate" is the SDK's prefix on the
  // synthetic body — match it directly so we trip even if the 401 isn't in
  // the substring (some surface variants drop the status code).
  if (t.includes("failed to authenticate")) return true;
  // The combination form: a 401 mentioned alongside any authentication
  // language. Keeps the false-positive radius small.
  if (t.includes("401") && t.includes("authenticat")) return true;
  return false;
}

/**
 * Pull concatenated text out of an SDK assistant message's `content`
 * (string or block array). Mirrors the helpers in
 * `opus-overload-detector.ts` and `thinking-replay-recovery.ts` — duplicated
 * rather than imported to keep this module zero-dep and individually
 * unit-testable.
 */
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null;
    if (b?.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/**
 * Inspect one SDK message and return true iff it carries an
 * `authentication_failed` signal that should fire the nudge. Two surfaces:
 *
 *   1. Structured: the SDK's `SDKAssistantMessageError` enum on the
 *      assistant envelope — `error === 'authentication_failed'`. This is
 *      the cleanest channel; cheap to match exactly.
 *   2. Text fallback: the synthetic *assistant* message whose body is
 *      `"API Error: 401 …"` or `"Failed to authenticate …"`. This is what
 *      surfaces in chat today (the user actually sees that text) and is
 *      where the nudge needs to ride if the structured channel is empty.
 *
 * Exported for unit testing.
 */
export function isAuthFailedSignal(sdkMessage: unknown): boolean {
  if (!sdkMessage || typeof sdkMessage !== "object") return false;
  const m = sdkMessage as {
    type?: string;
    error?: unknown;
    message?: unknown;
  };
  if (m.type !== "assistant") return false;
  // (1) Structured signal.
  if (m.error === "authentication_failed") return true;
  // (2) Text fallback.
  return isAuthFailedErrorText(extractAssistantText(m.message));
}
