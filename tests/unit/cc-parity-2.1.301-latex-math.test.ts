import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { normalizeMathDelimiters } from "@/lib/shared/math-delimiters";

/**
 * CC 2.1.301 ([VSCode] "Added LaTeX math rendering in Claude's responses,
 * including `$$` and multi-line `\[ … \]` blocks and inline `$…$` and
 * `\(…\)` math").
 */
describe("normalizeMathDelimiters", () => {
  test("returns the same string when there is no delimiter", () => {
    const s = "plain prose, no math";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  test("inline $…$ that passes the Pandoc rule becomes $$…$$", () => {
    expect(normalizeMathDelimiters("Euler: $e^{i\\pi}+1=0$.")).toBe("Euler: $$e^{i\\pi}+1=0$$.");
    expect(normalizeMathDelimiters("between $a$ and $b$")).toBe("between $$a$$ and $$b$$");
  });

  test("prices and shell variables stay literal", () => {
    for (const s of ["It costs $5 and $10.", "$5-$10 range", "US$5 or US$6", "echo $HOME/$PATH", "set $FOO to $BAR"]) {
      expect(normalizeMathDelimiters(s)).toBe(s);
    }
  });

  test("escaped dollars are kept as escapes", () => {
    expect(normalizeMathDelimiters("\\$x\\$ is literal")).toBe("\\$x\\$ is literal");
  });

  test("\\( … \\) becomes inline $$…$$", () => {
    expect(normalizeMathDelimiters("so \\(x^2\\) grows")).toBe("so $$x^2$$ grows");
  });

  test("multi-line \\[ … \\] becomes a $$ block on its own lines", () => {
    const out = normalizeMathDelimiters("Sum:\n\\[\n\\sum_{i=1}^n i\n  = \\frac{n(n+1)}{2}\n\\]\nDone.");
    expect(out).toBe("Sum:\n$$\n\\sum_{i=1}^n i\n= \\frac{n(n+1)}{2}\n$$\nDone.");
  });

  test("a mid-line \\[ … \\] is split onto its own lines", () => {
    expect(normalizeMathDelimiters("We get \\[x=1\\] here")).toBe("We get \n$$\nx=1\n$$\n here");
  });

  test("a \\[ … \\] inside a list item or blockquote stays in it", () => {
    expect(normalizeMathDelimiters("- Energy: \\[E=mc^2\\]")).toBe("- Energy: \n  $$\n  E=mc^2\n  $$");
    expect(normalizeMathDelimiters("> so \\[a+b\\] holds")).toBe("> so \n> $$\n> a+b\n> $$\n>  holds");
    expect(normalizeMathDelimiters("10. step \\[x_1\\]")).toBe("10. step \n    $$\n    x_1\n    $$");
  });

  test("an escaped bracket that isn't TeX stays literal", () => {
    expect(normalizeMathDelimiters("Mark it \\[Done\\] and \\(see above\\)")).toBe("Mark it \\[Done\\] and \\(see above\\)");
  });

  test("existing $$ blocks are untouched", () => {
    const s = "$$\na $b$ c\n$$";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  test("fenced code and inline code are never rewritten", () => {
    const fenced = "```sh\necho $HOME $x$\n\\[a\\]\n```\nthen $y$";
    expect(normalizeMathDelimiters(fenced)).toBe("```sh\necho $HOME $x$\n\\[a\\]\n```\nthen $$y$$");
    expect(normalizeMathDelimiters("run `echo $a$` and $b$")).toBe("run `echo $a$` and $$b$$");
    expect(normalizeMathDelimiters("~~~\n$q$\n~~~")).toBe("~~~\n$q$\n~~~");
  });

  test("an unclosed fence (mid-stream) keeps the rest as code", () => {
    const s = "```py\nprint('$x$')";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  test("unclosed delimiters (mid-stream) are left as typed", () => {
    for (const s of ["half \\[ x + ", "half \\( y", "half $z", "half $$\nw"]) {
      expect(normalizeMathDelimiters(s)).toBe(s);
    }
  });
});

describe("Markdown math rendering", () => {
  const render = (text: string, math = true) => renderToStaticMarkup(createElement(Markdown, { math } as { math: boolean; children: string }, text));

  test("inline $…$ typesets with KaTeX", () => {
    const html = render("Euler: $e^{i\\pi}+1=0$.");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-display");
  });

  test("a paragraph that is only one inline formula stays inline", () => {
    const html = render("$x^2$");
    expect(html).toContain('class="katex"');
  });

  test("\\[ … \\] and $$ blocks render as display math", () => {
    expect(render("\\[\n\\int_0^1 x\\,dx\n\\]")).toContain("katex-display");
    expect(render("$$\n\\frac{a}{b}\n$$")).toContain("katex-display");
  });

  test("display math written in a bullet renders inside that bullet", () => {
    const html = render("- Energy: \\[E=mc^2\\]\n- Next item");
    const li = html.slice(html.indexOf("<li"), html.indexOf("</li>"));
    expect(li).toContain("katex-display");
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  test("prices stay prose", () => {
    const html = render("It costs $5 and $10.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 and $10");
  });

  test("malformed TeX does not throw", () => {
    expect(() => render("$$\n\\frac{a}{\n$$")).not.toThrow();
  });

  test("math is off by default (user prompts keep their dollars)", () => {
    const html = render("between $a$ and $b$", false);
    expect(html).not.toContain("katex");
    expect(html).toContain("$a$");
  });

  test("\\href is not turned into a link (KaTeX trust stays off)", () => {
    const html = render("$\\href{javascript:alert(1)}{x}$");
    expect(html).not.toContain('href="javascript');
  });
});
