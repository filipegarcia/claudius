import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";

/**
 * CC 2.1.274/2.1.281 (F1) — the ordered-list renderer must honor `start`, so a
 * list beginning at 3 renders 3./4./5. instead of being renumbered to 1./2./3.
 */
describe("Markdown ordered-list start (F1)", () => {
  test("a list starting at 3 keeps start=3", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "3. three\n4. four\n5. five"));
    expect(html).toContain("<ol");
    expect(html).toMatch(/start="3"/);
  });

  test("a normal list starting at 1 is not force-renumbered to 3", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "1. a\n2. b"));
    expect(html).not.toMatch(/start="3"/);
  });
});
