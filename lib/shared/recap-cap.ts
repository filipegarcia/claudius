/**
 * CC 2.1.236 (H8) — cap a session recap so a runaway model response can't
 * produce a multi-paragraph "one-liner". Claude Code trims the recap to 400
 * characters at a word boundary; this mirrors that.
 *
 * Pure + dependency-free so the boundary logic is unit-testable.
 */

export const RECAP_MAX_CHARS = 400;

/**
 * Trim `text` to at most `max` characters, breaking at the last whitespace
 * within the budget (so a word isn't cut mid-token) and appending an ellipsis.
 * Falls back to a hard cut when there's no usable space near the end (a single
 * very long token). Returns the text unchanged when it's already within budget.
 */
export function capRecap(text: string, max: number = RECAP_MAX_CHARS): string {
  if (text.length <= max) return text;
  // Reserve room for the ellipsis so the result never exceeds `max`.
  const budget = Math.max(1, max - 1);
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  // Only break at the space when it keeps a reasonable amount of text
  // (avoids throwing away most of the recap for an early single space).
  const cut = lastSpace > budget * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
