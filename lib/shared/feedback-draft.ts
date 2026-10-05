/**
 * Claude Code 2.1.247 — the model-drafted `SendFeedback` tool. When something
 * goes wrong in a session, Claude can draft a feedback report for the user to
 * review and send from `/feedback` (see the `feedbackDrafts` setting in
 * `lib/server/settings.ts`).
 *
 * CC 2.1.247 (F10): the tool's input schema IS public —
 * `SendFeedbackInput { type, title, details, area?, failure_mode?,
 * task_category? }` (`sdk-tools.d.ts`). The earlier extractor probed
 * `report/feedback/description/summary/text`, none of which the schema uses,
 * so the transcript card always fell back to a raw-JSON dump. This reads the
 * real `title` + `details` (the markdown-bulleted body) and composes them for
 * the card, keeping the old keys only as a defensive fallback against drift.
 */

const DRAFT_TEXT_KEYS = ["report", "feedback", "description", "summary", "text"] as const;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Compose a readable markdown body for the drafted-report card from a
 * `SendFeedback` tool input. The `title` becomes a bold headline and the
 * `details` (already markdown bullets) follow. Returns `null` only when the
 * input carries nothing recognizable, so the caller can fall back to the
 * generic JSON dump `ToolCall` renders for every other tool.
 */
export function extractFeedbackDraftText(input: Record<string, unknown>): string | null {
  const title = nonEmptyString(input.title);
  const details = nonEmptyString(input.details);
  if (title || details) {
    const parts: string[] = [];
    if (title) parts.push(`**${title}**`);
    if (details) parts.push(details);
    return parts.join("\n\n");
  }
  // Defensive fallback for an unexpected/older shape.
  for (const key of DRAFT_TEXT_KEYS) {
    const value = nonEmptyString(input[key]);
    if (value) return value;
  }
  return null;
}
