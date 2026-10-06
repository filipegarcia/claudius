import { createElement } from "react";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, test } from "vitest";
import {
  MAX_MARKDOWN_NESTING,
  isMarkdownTooDeep,
  markdownNestingDepth,
} from "@/lib/shared/markdown-nesting";

/**
 * CC 2.1.290 parity — "Fixed a crash ("Maximum call stack size exceeded")
 * when a response nested lists or quotes thousands of levels deep."
 * `Markdown.tsx` falls back to plain text past `MAX_MARKDOWN_NESTING`.
 */

const nestedList = (depth: number, indent = "  ") =>
  Array.from({ length: depth }, (_, i) => `${indent.repeat(i)}- item ${i}`).join("\n");

describe("markdownNestingDepth (CC 2.1.290)", () => {
  test("counts nested blockquotes, lists and mixed containers", () => {
    expect(markdownNestingDepth("> > > hi")).toBe(3);
    expect(markdownNestingDepth(">>> hi")).toBe(3);
    expect(markdownNestingDepth(nestedList(5))).toBe(5);
    expect(markdownNestingDepth("> - > 1. > x")).toBe(5);
  });

  test("flags the inputs that crash or stall react-markdown", () => {
    expect(isMarkdownTooDeep(`${">".repeat(3000)} hi`)).toBe(true);
    expect(isMarkdownTooDeep(nestedList(2000))).toBe(true);
    expect(isMarkdownTooDeep(Array.from({ length: 500 }, () => "> -").join(" "))).toBe(true);
  });

  test("leaves ordinary replies alone", () => {
    const reply = [
      "## Plan",
      "",
      nestedList(6, "    "),
      "",
      "1. first",
      "   2. nested ordered",
      "",
      ">>> import os  # a Python REPL line",
      "",
      "<<<<<<< HEAD",
      "=======",
      ">>>>>>> feature-branch",
      "",
      "- - -",
      "",
      "```yaml",
      "a:",
      `${" ".repeat(120)}- deeply indented yaml`,
      "```",
      "",
      "```python",
      `${" ".repeat(200)}return x`,
      "```",
    ].join("\n");
    expect(markdownNestingDepth(reply)).toBeLessThan(20);
    expect(isMarkdownTooDeep(reply)).toBe(false);
  });

  test("skips nesting inside fenced code, including tilde fences and fences in quotes", () => {
    expect(markdownNestingDepth(["```", ">".repeat(5000), "```"].join("\n"))).toBe(0);
    expect(markdownNestingDepth(["~~~", nestedList(500), "~~~"].join("\n"))).toBe(0);
    // a ``` line inside a ~~~ fence doesn't close it
    expect(markdownNestingDepth(["~~~", "```", nestedList(500), "~~~"].join("\n"))).toBe(0);
    expect(markdownNestingDepth(["> ```", `> ${">".repeat(500)}`, "> ```"].join("\n"))).toBe(0);
  });

  test("an unclosed fence runs to the end, as in CommonMark", () => {
    expect(markdownNestingDepth(["```", nestedList(500)].join("\n"))).toBe(0);
  });

  test("indentation alone (no container marker) doesn't count", () => {
    expect(markdownNestingDepth(`${" ".repeat(400)}just indented text`)).toBe(0);
  });

  test("stops scanning once past stopAt", () => {
    const depth = markdownNestingDepth(nestedList(5000), MAX_MARKDOWN_NESTING);
    expect(depth).toBeGreaterThan(MAX_MARKDOWN_NESTING);
    expect(depth).toBeLessThan(MAX_MARKDOWN_NESTING + 5);
  });

  test("everything at the cap still parses quickly", () => {
    const atCap = [
      `${">".repeat(MAX_MARKDOWN_NESTING)} quoted`,
      nestedList(MAX_MARKDOWN_NESTING / 2, "    "),
      nestedList(MAX_MARKDOWN_NESTING),
    ].join("\n\n");
    expect(isMarkdownTooDeep(atCap)).toBe(false);
    const started = performance.now();
    renderToString(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, atCap));
    // ~40ms locally; the generous bound only guards against a regression to
    // the super-linear blow-up (a 200-level list already takes ~250ms).
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
