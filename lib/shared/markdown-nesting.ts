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

/**
 * CC 2.1.328 parity — "Fixed markdown rendering freezing on some very long or
 * malformed input".
 *
 * `react-markdown` + `remark-gfm` also go super-linear on shapes that don't
 * nest at all (measured with `renderToStaticMarkup`):
 *  - one long paragraph dense with emphasis delimiters — `*_` ×8,000 (16 KB)
 *    ≈ 1.4 s, `2*3*4 ` ×5,400 (32 KB) ≈ 1.9 s; split into short paragraphs
 *    the same text is fast;
 *  - a GFM table with a huge delimiter row — 4,000 columns ≈ 1 s;
 *  - many table cells — 3 × 4,000 rows ≈ 2.4 s (3 × 2,000 ≈ 0.7 s), and the
 *    cost adds up across every table in the message.
 * The parse runs again on every streaming delta, so such a reply stalls the
 * tab while it streams. `isMarkdownTooCostly` is the linear pre-scan
 * `Markdown.tsx` checks first, the same pattern as the nesting guard above.
 *
 * At the caps the slowest shapes parse in ~50 ms (1,500 `*_` delimiters),
 * ~25 ms (256 columns) and ~300 ms (3,000 cells). A 30 KB multi-paragraph
 * reply or a 200-row table stays far below them.
 */
export const MAX_PARAGRAPH_DELIMITERS = 1500;
export const MAX_TABLE_COLUMNS = 256;
export const MAX_TABLE_CELLS = 3000;

/**
 * Where `line`'s content starts after its container prefix (indentation, `>`
 * quote markers, list markers), and whether that prefix opened a list item.
 */
function containerPrefix(line: string): { end: number; listItem: boolean } {
  const n = line.length;
  let i = 0;
  let listItem = false;
  for (;;) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    const ch = line[i];
    if (ch === ">") {
      i++;
    } else if ((ch === "-" || ch === "*" || ch === "+") && i + 1 < n && isBlank(line[i + 1])) {
      i++;
      listItem = true;
    } else if (isDigit(ch)) {
      let j = i;
      while (j < n && j - i < 9 && isDigit(line[j])) j++;
      if ((line[j] !== "." && line[j] !== ")") || !isBlank(line[j + 1])) return { end: i, listItem };
      i = j + 1;
      listItem = true;
    } else {
      return { end: i, listItem };
    }
  }
}

/**
 * Columns of a GFM table delimiter row (`| --- | :-: |`, `---|---`) starting
 * at `from`, or 0 when `line` isn't one. Needs at least one `|`, so a
 * thematic break or setext underline (`---`) is not a table.
 */
function delimiterRowColumns(line: string, from: number): number {
  const n = line.length;
  let i = from;
  let pipes = 0;
  let cols = 0;
  if (line[i] === "|") {
    pipes++;
    i++;
  }
  for (;;) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= n) break;
    if (line[i] === ":") i++;
    let dashes = 0;
    while (i < n && line[i] === "-") {
      dashes++;
      i++;
    }
    if (dashes === 0) return 0;
    if (line[i] === ":") i++;
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    cols++;
    if (i >= n) break;
    if (line[i] !== "|") return 0;
    pipes++;
    i++;
  }
  return pipes > 0 ? cols : 0;
}

/**
 * `*`, `_` and `~` in `line` from `from`, outside inline code spans. A
 * backtick run opens a span only when a later run of the same length closes
 * it (CommonMark); each run's next same-length run is precomputed right to
 * left, so this stays linear whatever the backticks look like.
 */
function emphasisDelimiters(line: string, from: number): number {
  let count = 0;
  const countRange = (a: number, b: number) => {
    for (let i = a; i < b; i++) {
      const c = line.charCodeAt(i);
      if (c === 42 || c === 95 || c === 126) count++; // * _ ~
    }
  };
  if (line.indexOf("`", from) === -1) {
    countRange(from, line.length);
    return count;
  }
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = from; i < line.length; ) {
    if (line.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i + 1;
    while (line.charCodeAt(j) === 96) j++;
    starts.push(i);
    lens.push(j - i);
    i = j;
  }
  const next = new Array<number>(starts.length);
  const latest = new Map<number, number>();
  for (let k = starts.length - 1; k >= 0; k--) {
    next[k] = latest.get(lens[k]) ?? -1;
    latest.set(lens[k], k);
  }
  let pos = from;
  for (let k = 0; k < starts.length; ) {
    const close = next[k];
    if (close === -1) {
      k++; // an unmatched run is literal backticks
      continue;
    }
    countRange(pos, starts[k]);
    pos = starts[close] + lens[close];
    k = close + 1;
  }
  countRange(pos, line.length);
  return count;
}

/**
 * True when `text` has a paragraph with more than
 * {@link MAX_PARAGRAPH_DELIMITERS} emphasis delimiters, a table delimiter row
 * wider than {@link MAX_TABLE_COLUMNS}, or more than {@link MAX_TABLE_CELLS}
 * table cells in all. Fenced code and inline code spans don't count (code is
 * rendered verbatim); a blank line, a list item or a heading starts a new
 * paragraph; table rows count as cells, not delimiters (each cell is parsed
 * on its own). Like the nesting scan it estimates rather than parses, and it
 * is linear — it stops at the first cap it passes.
 */
export function isMarkdownTooCostly(text: string): boolean {
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let delimiters = 0;
  let tableCols = 0;
  let cells = 0;
  for (const line of text.split("\n")) {
    const { end: i, listItem } = containerPrefix(line);
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
        delimiters = 0;
        tableCols = 0;
        continue;
      }
    }
    if (fenceChar !== null) continue;
    if (i >= line.trimEnd().length) {
      // A blank line ends the paragraph and any table.
      delimiters = 0;
      tableCols = 0;
      continue;
    }
    if (tableCols > 0) {
      cells += tableCols;
      if (cells > MAX_TABLE_CELLS) return true;
      continue;
    }
    const cols = delimiterRowColumns(line, i);
    if (cols > 0) {
      if (cols > MAX_TABLE_COLUMNS) return true;
      tableCols = cols;
      cells += cols * 2; // the header row and the delimiter row
      if (cells > MAX_TABLE_CELLS) return true;
      continue;
    }
    if (listItem || ch === "#") delimiters = 0;
    delimiters += emphasisDelimiters(line, i);
    if (delimiters > MAX_PARAGRAPH_DELIMITERS) return true;
    if (ch === "#") delimiters = 0;
  }
  return false;
}
