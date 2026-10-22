/**
 * CC 2.1.309 parity — "Fixed feedback saying 'try again later' when your
 * organization does not accept feedback; it now shows the server's reason and
 * where to report a bug."
 *
 * Claudius's session-quality survey forwards through the SDK's
 * `query.submitFeedback`. A refusal (e.g. "Your organization does not accept
 * feedback.") used to be swallowed into a bare `false`, so the banner always
 * blamed connectivity ("couldn't reach Anthropic"). This pulls a displayable
 * reason out of the rejection instead.
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
    .trim();
  if (!clean) return undefined;
  const chars = Array.from(clean);
  return chars.length > FEEDBACK_REASON_MAX
    ? `${chars.slice(0, FEEDBACK_REASON_MAX - 1).join("")}…`
    : clean;
}
