/**
 * CC 2.1.311 parity — "Fixed a lone backslash in quotes or brackets, like
 * `"\"` or `(\)`, disappearing from Claude's responses".
 *
 * Claudius renders replies with remark (CommonMark), where a backslash before
 * ASCII punctuation is an escape: `"\"` parses as `"` + escaped `"` and shows
 * as `""`, `(\)` as `()`, `[\]` as `[]`. When Claude writes a lone backslash
 * between a quote or bracket and its closer, it means the backslash itself
 * (a path separator, an escape character being described), so this
 * render-only pre-pass doubles it (`"\\"`), which CommonMark shows as one
 * literal `\`. The stored message text is untouched, so copy still yields
 * exactly what Claude wrote.
 *
 * Narrow on purpose:
 *  - only a `\` with an opener (`"`, `'`, `(`, `[`, `{`, `<`) right before it
 *    and that opener's closer right after it;
 *  - the opener must be a plain character, not the second half of an escape,
 *    so empty LaTeX delimiters (`\(\)`, `\[\]`) and escaped braces (`\{\}`)
 *    are left alone;
 *  - fenced / indented code blocks and inline code spans are never touched
 *    (they already show backslashes as typed);
 *  - every other backslash pair is copied unchanged, so `\\`, `\*` and
 *    `\(x\)` keep their meaning.
 */

import { inlineCodeEnd, mapProseSegments } from "@/lib/shared/math-delimiters";

const CLOSER_FOR: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
};

function preserveInProse(text: string): string {
  let out = "";
  let i = 0;
  // Index of the last character emitted as a plain (unescaped) character.
  let lastPlain = -1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "`") {
      const end = inlineCodeEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "\\") {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (
        prev !== undefined &&
        lastPlain === i - 1 &&
        Object.hasOwn(CLOSER_FOR, prev) &&
        next === CLOSER_FOR[prev]
      ) {
        // Lone backslash between an opener and its closer: make it literal.
        out += "\\\\";
        i += 1;
        continue;
      }
      // Any other backslash escape stays a pair.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += ch;
    lastPlain = i;
    i++;
  }
  return out;
}

/**
 * Double every lone backslash that sits between an opener and its closer, so
 * remark renders it instead of reading it as an escape. Returns the input
 * unchanged (same string) when it has no backslash.
 */
export function preserveLoneBackslashes(markdown: string): string {
  if (!markdown.includes("\\")) return markdown;
  return mapProseSegments(markdown, preserveInProse);
}
