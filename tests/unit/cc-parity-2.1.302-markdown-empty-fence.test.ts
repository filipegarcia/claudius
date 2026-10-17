import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";

/**
 * CC 2.1.302 ([VSCode] "Fixed text after an unclosed code block in a list
 * showing as plain text while a reply streams, then turning into code").
 *
 * The exact upstream case doesn't reproduce in Claudius — CommonMark closes an
 * unclosed fence at the end of its container, so a streaming partial and the
 * finished text give the same code block (asserted below). The adjacent flip
 * that did exist: a fence with no language and no body yet rendered as an
 * empty INLINE code chip until its first line arrived, because block-vs-inline
 * was guessed from a newline in the text. It is now decided by `<pre>`.
 */
const render = (md: string) => renderToStaticMarkup(createElement(Markdown, null, md));
const blocks = (html: string) => (html.match(/<pre[\s>]/g) ?? []).length;

describe("code fences render as blocks while streaming", () => {
  test("an opened fence with no language and no body is already a code block", () => {
    expect(blocks(render("Intro\n\n```\n"))).toBe(1);
    expect(blocks(render("- step\n  ```"))).toBe(1);
  });

  test("a finished empty fence is a code block, not an inline chip", () => {
    expect(blocks(render("```\n```"))).toBe(1);
  });

  test("an unclosed fence inside a list item is code both mid-stream and when closed", () => {
    const partial = "1. Run this:\n   ```bash\n   npm install\n   npm run build";
    const done = `${partial}\n   \`\`\``;
    for (const md of [partial, done]) {
      const html = render(md);
      expect(blocks(html)).toBe(1);
      expect(html).toContain("npm run build");
    }
  });

  test("a single-line block with no language stays a block", () => {
    expect(blocks(render("```\nls -la\n```"))).toBe(1);
  });
});

describe("inline code stays inline", () => {
  test("in a paragraph, a heading, a list item and a table cell", () => {
    for (const md of [
      "Run `npm test` now",
      "## The `config` key",
      "- use `foo`",
      "| a | b |\n|---|---|\n| `x` | y |",
    ]) {
      const html = render(md);
      expect(blocks(html)).toBe(0);
      expect(html).toContain("<code");
    }
  });
});
