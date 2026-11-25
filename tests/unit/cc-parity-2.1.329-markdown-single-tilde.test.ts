import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";

/** CC 2.1.329 — "Fixed a single tilde drawing strikethrough, e.g. in '3~5 days … 7~10 days'". */
describe("Markdown single tilde (2.1.329)", () => {
  const render = (md: string) => renderToStaticMarkup(createElement(Markdown, null, md));

  test("lone tildes between numbers are text, not strikethrough", () => {
    const html = render("Shipping takes 3~5 days, returns 7~10 days.");
    expect(html).not.toContain("<del");
    expect(html).toContain("3~5 days, returns 7~10 days");
  });

  test("double-tilde strikethrough still renders", () => {
    expect(render("this is ~~gone~~ now")).toContain("<del>gone</del>");
  });
});
