/**
 * CC 2.1.239 (F5) — long file paths on tool-use rows truncate in the *middle*
 * so the filename (the useful part) stays visible, rather than the CSS
 * end-ellipsis that cuts the filename off.
 *
 * Rather than measure pixels and compute a character budget (brittle in a
 * fluid layout), the row splits the path into a `head` (the directory prefix,
 * which CSS-truncates with an end-ellipsis) and a `tail` (the final segment =
 * the filename, rendered whole and non-shrinking). The visible result is
 * `…/dir-prefix…/file.ts` — the ellipsis lands before the last slash and the
 * filename is never cut.
 *
 * Pure + dependency-free so the split is unit-testable.
 */

/**
 * Split `path` at its last path separator (either `/` or `\`), keeping the
 * separator on the head so `head + tail === path`.
 *
 * - no separator → everything is the filename (`{ head: "", tail: path }`)
 * - a trailing separator (a directory) → the whole string is the head
 */
export function splitPathForTruncation(path: string): { head: string; tail: string } {
  if (!path) return { head: "", tail: "" };
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i === -1) return { head: "", tail: path };
  return { head: path.slice(0, i + 1), tail: path.slice(i + 1) };
}
