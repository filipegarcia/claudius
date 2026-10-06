/**
 * CC 2.1.290 parity — "Fixed a crash ("Maximum call stack size exceeded")
 * when a response nested lists or quotes thousands of levels deep."
 *
 * Claudius renders every chat bubble through `react-markdown`, which has the
 * same failure: ~2,000 nested `>` quotes throw `RangeError: Maximum call stack
 * size exceeded` during the parse, and nested lists slow down far sooner (the
 * render time grows much faster than linearly — ~15ms at 64 levels, ~250ms at
 * 200, and a 2,000-level list never finished). The parse runs again on every
 * streaming delta, so a deep reply also freezes the tab while it streams.
 *
 * `markdownNestingDepth` is a cheap, linear pre-scan that estimates the
 * deepest container nesting (blockquotes and list items) WITHOUT invoking the
 * markdown parser, so `Markdown.tsx` can fall back to plain text before
 * `react-markdown` ever sees a pathological input. It is an estimate, not a
 * CommonMark parser: it errs toward over-counting (a list indented with four
 * spaces per level counts as twice as deep), which only ever means plain-text
 * rendering for absurdly deep input — never a crash.
 */

/**
 * Deepest nesting `Markdown.tsx` hands to the parser. Real prose rarely nests
 * past ~10 levels; at 64 the slowest shape (a two-space-indented list)
 * renders in ~15ms.
 */
export const MAX_MARKDOWN_NESTING = 64;

const isBlank = (ch: string | undefined) => ch === undefined || ch === " " || ch === "\t";
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * Estimated deepest blockquote/list nesting in `text`. Per line: the number of
 * container markers at its start (`>`, `-`/`*`/`+` bullets, `1.`/`1)` ordered
 * markers), plus half the leading indentation when the line opens with a
 * marker (nested list items are expressed through indentation, not repeated
 * markers). Lines inside fenced code blocks are skipped — code is rendered
 * verbatim and can't nest. Stops early once the depth exceeds `stopAt`.
 */
export function markdownNestingDepth(text: string, stopAt = Infinity): number {
  let max = 0;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of text.split("\n")) {
    const n = line.length;
    let i = 0;
    let indent = 0;
    while (i < n && (line[i] === " " || line[i] === "\t")) {
      indent += line[i] === "\t" ? 4 : 1;
      i++;
    }
    let markers = 0;
    for (;;) {
      const ch = line[i];
      if (ch === ">") {
        i++;
      } else if ((ch === "-" || ch === "*" || ch === "+") && isBlank(line[i + 1])) {
        i++;
      } else if (isDigit(ch)) {
        let j = i;
        while (j < n && j - i < 9 && isDigit(line[j])) j++;
        if ((line[j] === "." || line[j] === ")") && isBlank(line[j + 1])) i = j + 1;
        else break;
      } else {
        break;
      }
      markers++;
      while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    }
    // Fence detection runs on what's left after the container prefix, so a
    // fence opened inside a quote or list item (`> ```ts`) is recognised.
    const ch = line[i];
    if (ch === "`" || ch === "~") {
      let run = 0;
      while (line[i + run] === ch) run++;
      if (run >= 3) {
        if (fenceChar === null) {
          fenceChar = ch;
          fenceLen = run;
        } else if (ch === fenceChar && run >= fenceLen) {
          fenceChar = null;
        }
        continue;
      }
    }
    if (fenceChar !== null || markers === 0) continue;
    const depth = markers + Math.floor(indent / 2);
    if (depth > max) {
      max = depth;
      if (max > stopAt) return max;
    }
  }
  return max;
}

/** True when `text` nests deeper than `Markdown.tsx` will hand to the parser. */
export function isMarkdownTooDeep(text: string): boolean {
  return markdownNestingDepth(text, MAX_MARKDOWN_NESTING) > MAX_MARKDOWN_NESTING;
}
