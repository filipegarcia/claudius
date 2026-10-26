/**
 * CC 2.1.311 parity — "Changed the `ultrathink` rainbow to appear only where
 * the keyword can raise effort, and not when the word is quoted or part of a
 * file path."
 *
 * The 2.1.311 engine finds the keyword with a quote- and path-aware scanner
 * (the bundled CLI's `da(text, "ultrathink")`, shared with `ultraplan` /
 * `ultrareview`), and only that scanner gates the per-turn "deeper reasoning"
 * reminder. Claudius reimplements the TUI's prose-keyword reminder itself
 * (`ultrathinkReminderBody` in `lib/server/session.ts`), so it carries a
 * faithful port of that scanner:
 *
 *  - a prompt that starts with `/` (a slash command or a bare path) never
 *    matches;
 *  - text inside a quoted / bracketed span — backticks, `"…"`, `'…'`,
 *    `(…)`, `[…]`, `{…}` and `<tag…>` — is skipped. A `'` only opens a span
 *    when it isn't preceded by a word character, and only closes one when it
 *    isn't followed by one, so the apostrophe in `don't` neither opens nor
 *    closes a span;
 *  - a match touching `/`, `\` or `-` on either side, followed by `?`, or
 *    followed by `.` plus a word character (`ultrathink.md`), is part of a
 *    path, flag or file name and is skipped.
 *
 * Pure (no Node, no DOM) so it's unit-testable and usable from either side.
 */

/** Opener → closer pairs that delimit a span the keyword is ignored in. */
const SPAN_CLOSERS: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

export interface KeywordMatch {
  /** The matched text, original casing. */
  word: string;
  /** Inclusive start index in the scanned text. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Every occurrence of `keyword` in `text` that counts as the user typing the
 * keyword (not quoting it, not naming a file). `keyword` must be a plain
 * lowercase identifier — it is interpolated into a RegExp and is only ever
 * one of this module's constants, never user input.
 */
export function findKeyword(text: string, keyword: string): KeywordMatch[] {
  if (!text.toLowerCase().includes(keyword)) return [];
  if (text.startsWith("/")) return [];

  // Pass 1 — quoted / bracketed spans.
  const spans: Array<{ start: number; end: number }> = [];
  let opener: string | null = null;
  let spanStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (opener) {
      // A nested `[` restarts the bracket span (`[[x]]` → the inner one).
      if (opener === "[" && ch === "[") {
        spanStart = i;
        continue;
      }
      if (ch !== SPAN_CLOSERS[opener]) continue;
      if (opener === "'" && isWordChar(text[i + 1])) continue;
      spans.push({ start: spanStart, end: i + 1 });
      opener = null;
    } else if (
      (ch === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1])) ||
      (ch === "'" && !isWordChar(text[i - 1])) ||
      (ch !== "<" && ch !== "'" && Object.hasOwn(SPAN_CLOSERS, ch))
    ) {
      opener = ch;
      spanStart = i;
    }
  }

  // Pass 2 — whole-word matches outside those spans and not part of a path.
  const out: KeywordMatch[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    const before = text[start - 1];
    const after = text[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && isWordChar(text[end + 1])) continue;
    out.push({ word: m[0], start, end });
  }
  return out;
}

/**
 * True when `text` carries a live `ultrathink`. `pastes` are the large pastes
 * the composer recorded for this prompt (`inline_pastes`): Claude Code scans
 * the prompt *before* paste expansion, where those are `[Pasted text #N]`
 * placeholders, so a keyword that only appears inside pasted text doesn't
 * count.
 */
export function hasUltrathinkKeyword(text: string, pastes: readonly string[] = []): boolean {
  const matches = findKeyword(text, "ultrathink");
  if (matches.length === 0) return false;
  if (pastes.length === 0) return true;
  const pasted: Array<{ start: number; end: number }> = [];
  for (const p of pastes) {
    if (!p) continue;
    for (let at = text.indexOf(p); at !== -1; at = text.indexOf(p, at + p.length)) {
      pasted.push({ start: at, end: at + p.length });
    }
  }
  return matches.some((m) => !pasted.some((r) => m.start >= r.start && m.end <= r.end));
}
