/**
 * CC 2.1.326 parity — "Fixed asterisks disappearing from your own prompts in
 * the transcript, such as `src/**\/*.ts` or `2*3*4`".
 *
 * Since 2.1.234 Claudius renders the user's own prompt as markdown
 * (`UserMessage.tsx`, `TranscriptViewer.tsx`). CommonMark lets a `*` between
 * two word characters open and close emphasis, so `2*3*4` showed as 2<em>3</em>4
 * and `src/**\/*.ts lib/**\/*.ts` turned the middle into bold, with the asterisks
 * gone. This render-only pre-pass escapes a run of `*` when the characters on
 * both sides of it are "path-ish" (a letter, digit, `/` or `.`), which is where
 * a person typing a glob or a product means the asterisk itself.
 *
 * Deliberate emphasis keeps working, because its delimiters sit next to a
 * space or other punctuation: `**bold**`, `(*note*)`, `**Note:** text`. Code
 * spans, fenced / indented code and URLs are left as typed. The stored prompt
 * text is untouched, so copy still yields exactly what was typed.
 */

import { inlineCodeEnd, mapProseSegments } from "@/lib/shared/math-delimiters";

const PATHISH = /[\p{L}\p{N}/.]/u;

function inUrlToken(text: string, i: number): boolean {
  let start = i;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = i;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const tok = text.slice(start, end);
  return tok.includes("://") || /^[<(]*www\./i.test(tok);
}

function escapeInProse(text: string): string {
  let out = "";
  let i = 0;
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
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "*") {
      let j = i;
      while (text[j] === "*") j++;
      const run = text.slice(i, j);
      const prev = text[i - 1];
      const next = text[j];
      // `prev` is a raw character, never the second half of an escape: an
      // escape pair is consumed whole above, so an escaped `\*` never gets here.
      const literal =
        prev !== undefined && next !== undefined && PATHISH.test(prev) && PATHISH.test(next) && !inUrlToken(text, i);
      out += literal ? run.replace(/\*/g, "\\*") : run;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Escape the asterisks of a user prompt that a person meant literally. Same string back when there is no `*`. */
export function keepLiteralAsterisks(markdown: string): string {
  if (!markdown.includes("*")) return markdown;
  return mapProseSegments(markdown, escapeInProse);
}
