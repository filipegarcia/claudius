import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { isMarkdownTooCostly } from "@/lib/shared/markdown-nesting";

/**
 * CC 2.1.328 — "Fixed markdown rendering freezing on some very long or
 * malformed input".
 *
 * react-markdown + remark-gfm go super-linear on a few shapes: one long
 * paragraph dense with emphasis delimiters (`*_*_…`, `2*3*4 …`), a GFM table
 * with a huge delimiter row, and very many table cells. Measured locally
 * (renderToStaticMarkup): `*_` ×8,000 ≈ 1.4 s, `2*3*4 ` ×5,400 ≈ 1.9 s, a
 * 3 × 4,000-row table ≈ 2.4 s — and a streaming reply pays that on every
 * delta. Past the caps `Markdown` renders the plain-text fallback instead.
 */

const render = (md: string) => renderToStaticMarkup(createElement(Markdown, null, md));

function timed(md: string): { html: string; ms: number } {
  const t = performance.now();
  const html = render(md);
  return { html, ms: performance.now() - t };
}

const table = (cols: number, rows: number) =>
  "|" + " a |".repeat(cols) + "\n|" + "---|".repeat(cols) + "\n" + ("|" + " b |".repeat(cols) + "\n").repeat(rows);

// Warm the module graph so the first timed render isn't paying for imports.
render("warm *up*");

describe("long, malformed markdown renders without freezing (2.1.328)", () => {
  test.each([
    ["a 16 KB paragraph of *_", "*_".repeat(8000)],
    ["a 32 KB paragraph of 2*3*4", "2*3*4 ".repeat(5400)],
    ["a 32 KB paragraph of globs", "src/**/*.ts ".repeat(2700)],
    ["a table with 4,000 columns", table(4000, 1)],
    ["a 3-column table with 4,000 rows", table(3, 4000)],
  ])("%s renders in well under a second, as plain text", (_label, md) => {
    const { html, ms } = timed(md);
    expect(ms).toBeLessThan(500);
    expect(html).toContain('data-testid="markdown-plain-fallback"');
    expect(html).toContain("too long and irregular to format quickly");
  });
});

describe("isMarkdownTooCostly", () => {
  test("a realistic long reply still formats", () => {
    const para =
      "This is a realistic paragraph with `code`, **bold**, _italics_ and a [link](https://x.y). ".repeat(4) + "\n\n";
    const reply = para.repeat(Math.ceil(30_000 / para.length));
    expect(reply.length).toBeGreaterThan(30_000);
    expect(isMarkdownTooCostly(reply)).toBe(false);
    expect(render(reply)).not.toContain("markdown-plain-fallback");
  });

  test("a 200-row table still formats", () => {
    const t =
      "| name | value | note |\n|---|---|---|\n" +
      Array.from({ length: 200 }, (_, i) => `| row_${i} | **${i}** | some *note* here |`).join("\n");
    expect(isMarkdownTooCostly(t)).toBe(false);
    expect(render(t)).toContain("<table");
  });

  test("snake_case-heavy prose still formats", () => {
    const prose = Array.from({ length: 300 }, (_, i) => `set max_retry_count_${i} on the http_client`).join(", ");
    expect(isMarkdownTooCostly(prose)).toBe(false);
  });

  test("code full of * is not counted", () => {
    const fenced = "```ts\n" + "const x = a * b * c; // **/*.ts\n".repeat(2000) + "```\n";
    expect(isMarkdownTooCostly(fenced)).toBe(false);
    const tilde = "~~~\n" + "*_".repeat(5000) + "\n~~~\n";
    expect(isMarkdownTooCostly(tilde)).toBe(false);
    const inline = Array.from({ length: 600 }, () => "`**/*.ts`").join(" and ");
    expect(isMarkdownTooCostly(inline)).toBe(false);
  });

  test("delimiters are counted per paragraph, not per message", () => {
    const paras = Array.from({ length: 40 }, () => "*_".repeat(200)).join("\n\n");
    expect(isMarkdownTooCostly(paras)).toBe(false);
    expect(isMarkdownTooCostly("*_".repeat(800))).toBe(true);
  });

  test("a long tight list with bold labels still formats (each item is its own paragraph)", () => {
    const list = Array.from({ length: 600 }, (_, i) => `- **item_${i}**: does *something* useful`).join("\n");
    expect(isMarkdownTooCostly(list)).toBe(false);
    const { html, ms } = timed(list);
    expect(html).toContain("<strong>");
    expect(ms).toBeLessThan(1000);
  });

  test("a wide delimiter row or too many table cells trips it", () => {
    expect(isMarkdownTooCostly(table(256, 1))).toBe(false);
    expect(isMarkdownTooCostly(table(257, 1))).toBe(true);
    expect(isMarkdownTooCostly(table(3, 900))).toBe(false);
    expect(isMarkdownTooCostly(table(3, 1100))).toBe(true);
    // A pipe-heavy line with no delimiter row isn't a table (and is fast).
    expect(isMarkdownTooCostly("|" + " a |".repeat(8000))).toBe(false);
  });

  test("the scan stays linear: 1 MB in well under a second", () => {
    const big = ("word ".repeat(30) + "*x* " + "\n\n").repeat(7000);
    expect(big.length).toBeGreaterThan(1_000_000);
    const t = performance.now();
    isMarkdownTooCostly(big);
    expect(performance.now() - t).toBeLessThan(250);
  });
});
