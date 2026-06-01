/**
 * Detect whether an SDK message (or a thrown-error message string) carries
 * the "529 Overloaded" signal from Anthropic's API. Used by `Session` to
 * count consecutive overload events and, after a small threshold, surface
 * a manual "switch to Sonnet" nudge — distinct from the SDK's automatic
 * fallback path (Options.fallbackModel), which happens silently.
 *
 * Pure + dependency-light on purpose so the counter logic in `session.ts`
 * stays a thin wrapper and the matching can be unit-tested.
 *
 * Three surfaces carry the overload signal in practice:
 *
 *   1. A synthetic *assistant* message whose content is `"API Error: 529 …
 *      Overloaded"` text — the same shape `thinking-replay-recovery.ts`
 *      already matches on. This is the most common path when the model
 *      itself errors out without ending the turn cleanly.
 *   2. A `result` message with `subtype: "error_during_execution"` whose
 *      `errors: string[]` array contains an overload mention. This is the
 *      *turn-failed* terminal record.
 *   3. A `result` message of `subtype: "success"` carrying
 *      `api_error_status === 529` — this is the *fallback-rescued* case
 *      (the SDK retried and recovered). We deliberately do NOT count this
 *      one: the turn succeeded, the user doesn't need a nudge to switch.
 *
 * Plus a fallback for the catch-block path: a thrown Error whose message
 * mentions 529/Overloaded. We pipe that one through `isOverloadErrorText`.
 */

/**
 * True when `text` mentions Anthropic's 529 overload. Matches on either
 * the bare status code or the human phrase ("Overloaded") so we catch
 * both the API's JSON error body and free-form messages the SDK may
 * format around it.
 */
export function isOverloadErrorText(text: string): boolean {
  if (!text) return false;
  // Lower-case once so the substring checks don't need their own pass.
  const t = text.toLowerCase();
  // The bare "529" is too short to be a reliable substring match on its
  // own (a uuid fragment can collide), so anchor on either the http-style
  // phrasing or the explicit word.
  if (t.includes("overloaded")) return true;
  if (t.includes("529") && (t.includes("api error") || t.includes("status"))) {
    return true;
  }
  return false;
}

/**
 * Pull concatenated text out of an SDK assistant message's `content`
 * (string or block array). Mirrors `extractMessageText` in
 * `thinking-replay-recovery.ts` — duplicated rather than imported to keep
 * this module zero-dep and individually unit-testable.
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
 * Inspect one SDK message and return true iff it carries an overload signal
 * that should bump the consecutive-overload counter. Returns false for the
 * fallback-rescued success path (subtype "success" + api_error_status 529),
 * since the turn worked — the user does NOT need a "switch model" nudge.
 *
 * Exported for unit testing.
 */
export function isOverloadSignal(sdkMessage: unknown): boolean {
  const m = sdkMessage as
    | { type?: string; subtype?: string; errors?: unknown; message?: unknown }
    | null;
  if (!m) return false;

  // (1) Synthetic assistant "API Error" body — the most common surface.
  if (m.type === "assistant") {
    const text = extractAssistantText(m.message);
    return isOverloadErrorText(text);
  }

  // (2) Terminal result of subtype `error_during_execution` with a 529 in
  //     its `errors` array. Anything that lands as a turn-failing error
  //     here is what we want to surface; success results with
  //     `api_error_status: 529` are the auto-recovered case and skipped.
  if (m.type === "result" && m.subtype === "error_during_execution") {
    const errs = Array.isArray(m.errors) ? (m.errors as unknown[]) : [];
    for (const e of errs) {
      if (typeof e === "string" && isOverloadErrorText(e)) return true;
    }
  }

  return false;
}

/**
 * True when `model` is an Opus model id. The nudge text says "Opus is
 * experiencing high load, please use /model to switch to Sonnet" — firing
 * it for a Sonnet user is worse than silence, so this is the gate.
 */
export function isOpusModelId(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.toLowerCase().includes("opus");
}
