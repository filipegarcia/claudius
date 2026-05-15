/**
 * Markdown list helpers for the chat composer (and any other plain-text
 * textarea that wants Slack-style list editing).
 *
 * The composer is a `<textarea>` — no rich rendering — so we apply a few
 * markdown-aware shortcuts at the keystroke level:
 *
 *   - typing `* ` at the start of a (possibly indented) line is swapped for
 *     `• ` so the textarea reads as a bulleted list to a human
 *   - pressing Enter on a non-empty list item continues the list (Tab keeps
 *     working for indent / outdent)
 *   - pressing Enter on an *empty* list item exits the list, matching the
 *     VS Code / Slack behaviour everyone already has muscle memory for
 *
 * Bullets are stored as `•` in the textarea (visible character) and
 * `bulletsToMarkdown()` converts them back to `*` right before send, so
 * Claude and any markdown renderer downstream see the syntax they expect.
 *
 * These functions are deliberately pure (string in, string/struct out) so
 * the unit suite under `tests/unit/` can exercise them in a node environment
 * without instantiating React.
 */

/** Bullet glyph used in the textarea. Substituted back to `*` on send. */
export const BULLET_GLYPH = "•";

/**
 * Outcome of pressing Enter on a list line.
 *  - `empty`: the marker carried no content; the caller should clear it and
 *    let the user fall out of the list.
 *  - `next`: the caller should insert `\n` + `next` to continue the list
 *    with the right marker (incremented for numbered lists).
 */
export type ListContinuation = { kind: "empty" } | { kind: "next"; next: string };

/**
 * Inspect a single line and decide what should happen when the user presses
 * Enter on it. Returns `null` if the line is not a list item.
 *
 * Order of patterns is load-bearing: the checkbox pattern (`- [ ] foo`) is
 * a refinement of the plain `-` bullet and must be tested first, otherwise
 * the bullet branch would match and we'd lose the checkbox marker.
 */
export function computeListContinuation(line: string): ListContinuation | null {
  const cb = /^(\s*)(- \[[ xX]\])(\s+)(.*)$/.exec(line);
  if (cb) {
    const [, indent, , , content] = cb;
    if (content.trim() === "") return { kind: "empty" };
    return { kind: "next", next: `${indent}- [ ] ` };
  }
  const num = /^(\s*)(\d+)\.(\s+)(.*)$/.exec(line);
  if (num) {
    const [, indent, n, , content] = num;
    if (content.trim() === "") return { kind: "empty" };
    return { kind: "next", next: `${indent}${Number(n) + 1}. ` };
  }
  const bul = /^(\s*)([•*\-])(\s+)(.*)$/.exec(line);
  if (bul) {
    const [, indent, marker, , content] = bul;
    if (content.trim() === "") return { kind: "empty" };
    return { kind: "next", next: `${indent}${marker} ` };
  }
  return null;
}

/**
 * True if the line begins with a list marker (any flavour, possibly indented).
 * Used to decide whether Tab / Shift+Tab should hijack the keystroke for
 * indent/outdent instead of letting it move focus.
 */
export function isListLine(line: string): boolean {
  return /^(\s*)(- \[[ xX]\]|\d+\.|[•*\-])(\s+)/.test(line);
}

/**
 * Convert visible bullet glyphs back to markdown asterisks before sending.
 * Only the leading bullet on each line is rewritten — a `•` that appears
 * mid-sentence (because the user typed it themselves) is left alone.
 */
export function bulletsToMarkdown(text: string): string {
  return text.replace(/^(\s*)• /gm, "$1* ");
}
