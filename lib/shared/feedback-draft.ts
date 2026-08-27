/**
 * Claude Code 2.1.247 — the model-drafted `SendFeedback` tool. When
 * something goes wrong in a session, Claude can draft a feedback report for
 * the user to review and send from `/feedback` (see the `feedbackDrafts`
 * setting in `lib/server/settings.ts`).
 *
 * The tool's input schema isn't part of the SDK's public type surface (only
 * the `feedbackDrafts` setting is documented — see `sdk.d.ts`), so this
 * extractor is defensive: it checks the field names a drafted-report tool
 * plausibly uses, in order of specificity, and falls back to `null` (the
 * caller then falls back to the generic JSON input dump `ToolCall` already
 * renders for every other tool) rather than guessing at a shape that isn't
 * documented anywhere.
 */

const DRAFT_TEXT_KEYS = ["report", "feedback", "description", "summary", "text"] as const;

export function extractFeedbackDraftText(input: Record<string, unknown>): string | null {
  for (const key of DRAFT_TEXT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
