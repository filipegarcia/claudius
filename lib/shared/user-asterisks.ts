/**
 * CC 2.1.326 parity — "Fixed asterisks disappearing from your own prompts in
 * the transcript, such as `src/**\/*.ts` or `2*3*4`".
 *
 * Since 2.1.234 Claudius renders the user's own prompt as markdown
 * (`UserMessage.tsx`, `TranscriptViewer.tsx`). CommonMark lets a `*` between
 * two word characters open and close emphasis, so `2*3*4` showed as 2<em>3</em>4
 * and `src/**\/*.ts lib/**\/*.ts` turned the middle into bold, with the asterisks
 * gone. This render-only pre-pass escapes a run of `*` that sits between two
 * non-space characters where a person means the asterisk itself:
 *  - next to a `/` (`src/**` + `/x`, `lib/*.ts`);
 *  - next to a `.` that is part of a name, i.e. with a letter or digit on its
 *    far side (`*.ts`, `x.*y`), but not a full stop (`*now*.` stays italic);
 *  - between two digits (`2*3*4`, `10**6`).
 *
 * Deliberate emphasis keeps working: `**bold**`, `(*note*)`, `**Note:** text`,
 * `*now*.`, and intraword emphasis between letters (`foo**bar**`). Code spans,
 * fenced / indented code and URLs are left as typed. The stored prompt text is
 * untouched, so copy still yields exactly what was typed.
 */

import { inlineCodeEnd, mapProseSegments } from "@/lib/shared/math-delimiters";

const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

/** Whether the run between `i` (first `*`) and `j` (one past the last) is a literal asterisk. */
function isLiteralRun(text: string, i: number, j: number): boolean {
  const prev = text[i - 1];
  const next = text[j];
  if (prev === undefined || next === undefined || SPACE.test(prev) || SPACE.test(next)) return false;
  if (prev === "/" || next === "/") return true;
  if (next === "." && text[j + 1] !== undefined && ALNUM.test(text[j + 1])) return true;
  if (prev === "." && text[i - 2] !== undefined && ALNUM.test(text[i - 2])) return true;
  return DIGIT.test(prev) && DIGIT.test(next);
}

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
      // An escape pair is consumed whole above, so an escaped `\*` never
      // gets here and `text[i - 1]` is always a raw character.
      const literal = isLiteralRun(text, i, j) && !inUrlToken(text, i);
      out += literal ? run.replace(/\\/g, "\\\\").replace(/\*/g, "\\*") : run;
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
