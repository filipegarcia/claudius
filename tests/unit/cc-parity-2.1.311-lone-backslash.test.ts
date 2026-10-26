import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { preserveLoneBackslashes } from "@/lib/shared/lone-backslash";

/**
 * CC 2.1.311 parity — "Fixed a lone backslash in quotes or brackets, like
 * `"\"` or `(\)`, disappearing from Claude's responses".
 */

const render = (text: string, math = true): string =>
  renderToStaticMarkup(createElement(Markdown, { math } as { math: boolean; children: string }, text));

/** Visible text of the rendered HTML (tags stripped, entities decoded). */
const visible = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("preserveLoneBackslashes", () => {
  test("returns the same string when there is no backslash", () => {
    const s = 'Use "/" as the separator (default).';
    expect(preserveLoneBackslashes(s)).toBe(s);
  });

  test("doubles a backslash between an opener and its closer", () => {
    expect(preserveLoneBackslashes('Use "\\" as the separator')).toBe('Use "\\\\" as the separator');
    expect(preserveLoneBackslashes("the escape char (\\)")).toBe("the escape char (\\\\)");
    expect(preserveLoneBackslashes("class [\\] matches")).toBe("class [\\\\] matches");
    expect(preserveLoneBackslashes("it's '\\' here")).toBe("it's '\\\\' here");
    expect(preserveLoneBackslashes("map {\\} and <\\>")).toBe("map {\\\\} and <\\\\>");
  });

  test("leaves other escapes as pairs", () => {
    for (const s of ['"\\\\"', "\\*not bold\\*", "a \\_b\\_ c", "\\(x^2\\)", "\\[1\\]", '"\\n"', "(\\d+)"]) {
      expect(preserveLoneBackslashes(s)).toBe(s);
    }
  });

  test("an escaped opener isn't an opener: empty LaTeX delimiters stay as typed", () => {
    expect(preserveLoneBackslashes("empty \\(\\) and \\[\\] and \\{\\}")).toBe("empty \\(\\) and \\[\\] and \\{\\}");
  });

  test("code spans and fenced / indented code are untouched", () => {
    expect(preserveLoneBackslashes('run `split("\\")` now')).toBe('run `split("\\")` now');
    const fenced = 'Before (\\)\n```\nsplit("\\")\n```\nafter "\\"';
    expect(preserveLoneBackslashes(fenced)).toBe('Before (\\\\)\n```\nsplit("\\")\n```\nafter "\\\\"');
    const indented = 'Text:\n\n    sep = "\\"\n';
    expect(preserveLoneBackslashes(indented)).toBe(indented);
  });
});

describe("Markdown renders the lone backslash", () => {
  test('"\\", (\\) and [\\] keep their backslash in a reply', () => {
    const out = visible(render('Windows uses "\\" for paths, the escape is (\\), and a class [\\].'));
    expect(out).toContain('"\\"');
    expect(out).toContain("(\\)");
    expect(out).toContain("[\\]");
  });

  test("also without math (user-side rendering)", () => {
    expect(visible(render('split on "\\"', false))).toContain('split on "\\"');
  });

  test("a doubled backslash still renders as one", () => {
    expect(visible(render('already escaped "\\\\" stays one'))).toContain('"\\"');
  });

  test("inline LaTeX still renders as math", () => {
    const html = render("so \\(x^2\\) grows");
    expect(html).toContain("katex");
  });
});
