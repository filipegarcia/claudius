/**
 * CC 2.1.309 parity — "Fixed feedback saying 'try again later' when your
 * organization does not accept feedback; it now shows the server's reason and
 * where to report a bug."
 *
 * Claudius's session-quality survey forwards through the SDK's
 * `query.submitFeedback`. The engine answers a refusal (e.g. "Your
 * organization does not accept feedback.") as a *successful* control response
 * — `{ feedback_id: null, unavailable_reason, failure_reason? }` ("feedback_id
 * is set on success; otherwise unavailable_reason, failure_reason or both
 * explain why", engine schema) — which Claudius used to ignore, reporting the
 * refused report as sent. `interpretFeedbackResponse` reads that result;
 * `feedbackRefusalReason` makes the reason display-safe.
 */
import { stripAnsi } from "./hook-ask";

/** Cap on the reason shown in the one-line banner (code points). */
export const FEEDBACK_REASON_MAX = 200;

/**
 * A one-line, display-safe reason from whatever `submitFeedback` rejected
 * with, or `undefined` when there's nothing useful to show. ANSI and other
 * control characters are dropped, whitespace is collapsed, and the result is
 * capped by code point so an emoji is never cut in half.
 */
export function feedbackRefusalReason(err: unknown): string | undefined {
  let raw: unknown = err;
  if (err && typeof err === "object" && "message" in err) {
    raw = (err as { message?: unknown }).message;
  }
  if (typeof raw !== "string") return undefined;
  const clean = stripAnsi(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    // The engine's reasons can end with the CLI's own bug-report pointer;
    // the banner already links to the issue tracker right beside it.
    .replace(/\s*Report (?:issues|bugs) at \S+\s*$/i, "")
    .trim();
  if (!clean) return undefined;
  const chars = Array.from(clean);
  return chars.length > FEEDBACK_REASON_MAX
    ? `${chars.slice(0, FEEDBACK_REASON_MAX - 1).join("")}…`
    : clean;
}

export type FeedbackForwardResult = { forwarded: boolean; reason?: string };

/**
 * Interpret what `submitFeedback` resolved with.
 * - Not an object (older SDKs resolved with nothing useful) → sent, as before.
 * - A non-empty `feedback_id` → sent.
 * - `feedback_id` absent/null with an `unavailable_reason` → refused, with that
 *   reason (an org that doesn't accept feedback, feedback disabled, …).
 * - `feedback_id` absent/null with only a `failure_reason` (a code such as
 *   `http_error`) → not sent, no reason: the banner keeps its connectivity copy.
 * - Any other object shape → sent (unknown response, keep the old behaviour).
 */
export function interpretFeedbackResponse(res: unknown): FeedbackForwardResult {
  if (!res || typeof res !== "object") return { forwarded: true };
  const r = res as { feedback_id?: unknown; unavailable_reason?: unknown; failure_reason?: unknown };
  if (typeof r.feedback_id === "string" && r.feedback_id) return { forwarded: true };
  if (r.unavailable_reason !== undefined && r.unavailable_reason !== null) {
    const reason = feedbackRefusalReason(r.unavailable_reason);
    return reason ? { forwarded: false, reason } : { forwarded: false };
  }
  if (r.failure_reason !== undefined && r.failure_reason !== null) return { forwarded: false };
  return { forwarded: true };
}
