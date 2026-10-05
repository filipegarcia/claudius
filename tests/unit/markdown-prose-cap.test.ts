import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";

/**
 * CC 2.1.282 (F3) — prose blocks carry the `--prose-max-width` cap (and
 * `me-auto` so an RTL block stays on its own side), while tables and code
 * blocks keep full width. Capping prose but not tables/code is the whole
 * point of the feature, so both halves are asserted.
 */
describe("Markdown prose-width cap (F3)", () => {
  test("a paragraph carries the cap and me-auto", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "hello world"));
    expect(html).toMatch(/<p[^>]*class="[^"]*max-w-\[var\(--prose-max-width\)\]/);
    expect(html).toMatch(/<p[^>]*class="[^"]*\bme-auto\b/);
  });

  test("lists and blockquotes carry the cap", () => {
    expect(renderToStaticMarkup(createElement(Markdown, null, "- a\n- b"))).toMatch(
      /<ul[^>]*max-w-\[var\(--prose-max-width\)\]/,
    );
    expect(renderToStaticMarkup(createElement(Markdown, null, "> quote"))).toMatch(
      /<blockquote[^>]*max-w-\[var\(--prose-max-width\)\]/,
    );
  });

  test("deep headings (h4) now render with the cap (previously no renderer)", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "#### deep heading"));
    expect(html).toMatch(/<h4[^>]*max-w-\[var\(--prose-max-width\)\]/);
    expect(html).toMatch(/<h4 dir="auto"/);
  });

  test("tables keep full width (no cap)", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, "| a | b |\n| - | - |\n| 1 | 2 |"),
    );
    expect(html).toContain("<table");
    expect(html).not.toContain("--prose-max-width");
  });

  test("fenced code blocks keep full width (no cap)", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "```js\nfoo()\n```"));
    expect(html).not.toContain("--prose-max-width");
  });
});
