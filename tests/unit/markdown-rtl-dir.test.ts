import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";

/**
 * CC 2.1.216 (F2) — right-to-left text. Each prose block carries `dir="auto"`
 * so an Arabic/Hebrew/Persian paragraph flows RTL while English/code stays
 * LTR, and code (inline + fenced) is pinned `dir="ltr"` so it never reorders
 * or right-aligns when nested in RTL content. Logical padding (`ps-*`) keeps
 * list markers / quote borders on the correct side in RTL.
 */
describe("Markdown RTL dir=auto (F2)", () => {
  test("a paragraph emits dir=\"auto\"", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "שלום עולם"));
    expect(html).toMatch(/<p dir="auto"/);
  });

  test("inline code is pinned dir=\"ltr\"", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "run `foo()` now"));
    expect(html).toMatch(/<code dir="ltr"/);
  });

  test("a fenced code block wrapper is pinned dir=\"ltr\"", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "```js\nfoo()\n```"));
    expect(html).toMatch(/dir="ltr"/);
  });

  test("lists use logical start-padding (ps-5) and carry dir=\"auto\"", () => {
    const ul = renderToStaticMarkup(createElement(Markdown, null, "- one\n- two"));
    expect(ul).toMatch(/<ul dir="auto"[^>]*class="[^"]*\bps-5\b/);
    const ol = renderToStaticMarkup(createElement(Markdown, null, "1. one\n2. two"));
    expect(ol).toMatch(/<ol dir="auto"[^>]*class="[^"]*\bps-5\b/);
  });

  test("blockquote uses logical border/padding and dir=\"auto\"", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "> quoted"));
    expect(html).toMatch(/<blockquote dir="auto"[^>]*class="[^"]*\bborder-s-2\b/);
    expect(html).toMatch(/\bps-3\b/);
  });
});
