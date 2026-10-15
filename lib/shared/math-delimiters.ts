/**
 * CC 2.1.301 ([VSCode] "Added LaTeX math rendering in Claude's responses,
 * including `$$` and multi-line `\[ … \]` blocks and inline `$…$` and
 * `\(…\)` math").
 *
 * `remark-math` only understands dollar delimiters, and CommonMark reads
 * `\(` / `\[` as backslash escapes, so the LaTeX-style delimiters never reach
 * a plugin. This pure pre-pass rewrites the delimiters Claude writes into the
 * one shape `remark-math` parses with `singleDollarTextMath: false`:
 *
 *  - `\[ … \]` (may span lines)  → a `$$` fenced block on its own lines
 *  - `\( … \)` (one line)        → inline `$$…$$`
 *  - `$…$` that passes the Pandoc rule → inline `$$…$$`
 *  - existing `$$…$$` (inline or fenced) → copied unchanged
 *
 * Single `$` is never math on its own (`singleDollarTextMath: false`), so a
 * bare dollar stays prose unless this pass promotes it. The Pandoc rule keeps
 * prices and shell variables literal: the opening `$` must be followed by a
 * non-space and not preceded by a letter/digit, and the closing `$` must be
 * preceded by a non-space and not followed by a letter/digit. So `$5 and $10`,
 * `$5-$10`, `US$5` and `$HOME/$PATH` are all left as text.
 *
 * Code is never touched: fenced blocks (``` / ~~~, including an unclosed one
 * while a reply streams) and inline backtick spans are copied verbatim, and a
 * backslash escape (`\$`, `\\`) is kept as a pair. An unclosed `\[`, `\(` or
 * `$` is left as typed, so a half-streamed formula shows as source until its
 * closing delimiter arrives.
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Fast path: nothing that could be a math delimiter. */
function mayContainMath(text: string): boolean {
  return text.includes("$") || text.includes("\\[") || text.includes("\\(");
}

const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * The container prefix a block placed on its own lines must carry to stay
 * inside the same list item / blockquote as the text before `index`:
 * blockquote markers are repeated, a list marker becomes spaces of its width
 * (the item's content offset), plain indentation is kept.
 */
function containerPrefix(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const m = /^([ \t]*(?:>[ \t]?)*)(?:([-*+]|\d{1,9}[.)])([ \t]+))?/.exec(text.slice(start, index));
  if (!m) return "";
  return m[1] + (m[2] ? " ".repeat(m[2].length + m[3].length) : "");
}

/** Body text that reads as TeX, not an escaped bracket like `\[Done\]`. */
const TEX_HINT_RE = /[\\^_{}=+\-*/<>|0-9]/;

/**
 * Rewrite the math delimiters in one prose segment (no fenced code inside;
 * inline code spans are handled here).
 */
function normalizeProse(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    // Inline code span: a run of N backticks closes at the next run of exactly N.
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      let search = i + run;
      let close = -1;
      while (search < n) {
        const at = text.indexOf(fence, search);
        if (at === -1) break;
        let len = run;
        while (text[at + len] === "`") len++;
        if (len === run) {
          close = at;
          break;
        }
        search = at + len;
      }
      if (close === -1) {
        out += fence;
        i += run;
      } else {
        out += text.slice(i, close + run);
        i = close + run;
      }
      continue;
    }

    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "[" || next === "(") {
        const closer = next === "[" ? "\\]" : "\\)";
        const end = text.indexOf(closer, i + 2);
        const body = end === -1 ? "" : text.slice(i + 2, end);
        // `\(` is inline-only: a newline inside means it isn't a formula.
        if (end !== -1 && body.trim() && TEX_HINT_RE.test(body) && (next === "[" || !body.includes("\n"))) {
          if (next === "[") {
            // Keep the block inside the list item / blockquote it was written
            // in: every emitted line carries that container's prefix.
            const indent = containerPrefix(text, i);
            const atLineStart = /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
            const lines = body.trim().split("\n").map((l) => indent + l.trim());
            out += `${atLineStart ? "" : "\n" + indent}$$\n${lines.join("\n")}\n${indent}$$`;
            i = end + 2;
            // The closing fence must end its line.
            if (i < n && text[i] !== "\n") out += "\n" + indent;
          } else {
            out += `$$${body.trim()}$$`;
            i = end + 2;
          }
          continue;
        }
      }
      // Any other backslash escape stays a pair (`\$`, `\\`, `\*` …).
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "$") {
      // `$$…$$` (inline or a fenced block) is already remark-math syntax.
      if (text[i + 1] === "$") {
        const end = text.indexOf("$$", i + 2);
        if (end === -1) {
          out += text.slice(i);
          i = n;
        } else {
          out += text.slice(i, end + 2);
          i = end + 2;
        }
        continue;
      }
      // Single `$`: promote only when it passes the Pandoc-style rule.
      if (!isSpace(text[i + 1]) && !isWordChar(text[i - 1])) {
        let j = i + 1;
        let close = -1;
        while (j < n && text[j] !== "\n") {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j] === "$") {
            if (text[j + 1] === "$") break;
            close = j;
            break;
          }
          j++;
        }
        if (close !== -1 && !isSpace(text[close - 1]) && !isWordChar(text[close + 1]) && text[close + 1] !== "$") {
          out += `$$${text.slice(i + 1, close)}$$`;
          i = close + 1;
          continue;
        }
      }
      out += "$";
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Normalize every math delimiter in `markdown` to remark-math's `$$` form,
 * leaving fenced code blocks untouched. Returns the input unchanged (same
 * string) when it has no candidate delimiter.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!mayContainMath(markdown)) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;

  const flushProse = () => {
    if (prose.length) out.push(normalizeProse(prose.join("\n")));
    prose = [];
  };

  for (const line of lines) {
    if (fence) {
      out.push(line);
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && line.trim() === m[1]) fence = null;
      continue;
    }
    const m = FENCE_RE.exec(line);
    if (m) {
      flushProse();
      fence = { char: m[1][0], len: m[1].length };
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join("\n");
}
