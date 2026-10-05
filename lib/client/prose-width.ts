/**
 * CC 2.1.282 (F3) — `maxProseWidth` caps the width of prose (paragraphs,
 * headings, lists, blockquotes) in Claude's responses while tables and code
 * blocks keep full width. In the CLI the value is a count of terminal columns;
 * the browser analog is the `ch` unit (the advance width of "0" in the current
 * font), so `maxProseWidth: 80` becomes `80ch` applied via the
 * `--prose-max-width` CSS variable on the chat area, which the Markdown prose
 * renderers read.
 *
 * Pure + dependency-free so the clamping/validation is unit-testable in the
 * node test env, mirroring the other `lib/client` setting helpers.
 */

/** The catalog's documented minimum (matches the CLI's own floor). */
export const MIN_PROSE_WIDTH_COLS = 40;

/**
 * Convert a raw `maxProseWidth` setting value into a CSS length for
 * `--prose-max-width`, or `null` when it should be left unset (no cap →
 * prose wraps at the full chat column, the pre-F3 behavior).
 *
 * - non-number / non-numeric-string / non-finite / `<= 0` → `null` (unset).
 *   `settings.json` can be hand-edited, so numeric strings ("80") are accepted.
 * - `0 < n < 40` → clamped up to the documented minimum of 40 columns.
 * - otherwise rounded to a whole column count.
 */
export function proseMaxWidthCss(value: unknown): string | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  const cols = Math.max(MIN_PROSE_WIDTH_COLS, Math.round(n));
  return `${cols}ch`;
}
