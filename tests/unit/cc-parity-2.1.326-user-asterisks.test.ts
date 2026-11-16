import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { keepLiteralAsterisks } from "@/lib/shared/user-asterisks";

/**
 * CC 2.1.326 parity — "Fixed asterisks disappearing from your own prompts in
 * the transcript, such as `src/**` + `/*.ts` or `2*3*4`".
 */

const renderUser = (text: string): string =>
  renderToStaticMarkup(
    createElement(Markdown, { breaks: true, literalAsterisks: true, allowExecute: false } as never, text),
  );

const visible = (html: string): string => {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/&amp;/g, "&");
};

describe("keepLiteralAsterisks", () => {
  test("same string back when there is no asterisk", () => {
    const s = "plain prompt";
    expect(keepLiteralAsterisks(s)).toBe(s);
  });

  test("escapes asterisks between path-ish characters", () => {
    expect(keepLiteralAsterisks("2*3*4")).toBe("2\\*3\\*4");
    expect(keepLiteralAsterisks("src/**/*.ts")).toBe("src/\\*\\*/\\*.ts");
    expect(keepLiteralAsterisks("10**6")).toBe("10\\*\\*6");
    expect(keepLiteralAsterisks("lib/*.ts")).toBe("lib/\\*.ts");
  });

  test("deliberate emphasis is kept", () => {
    for (const s of [
      "**bold**",
      "this is *it* ok",
      "(*note*)",
      "**Note:** text",
      "a * b * c",
      "- * item",
      "Please do it *now*.",
      "This is **important**.",
      "it's *really*...",
      "foo**bar**",
      "**bold**s",
    ]) {
      expect(keepLiteralAsterisks(s)).toBe(s);
    }
  });

  test("code, escapes and URLs are untouched", () => {
    for (const s of ["run `src/**/*.ts`", "```\n2*3*4\n```", "a\\*b", "https://x.com/a*b*c", "www.x.com/a*b*c"]) {
      expect(keepLiteralAsterisks(s)).toBe(s);
    }
  });
});

describe("a user prompt renders its asterisks", () => {
  test("2*3*4 and globs show as typed", () => {
    const html = renderUser("What is 2*3*4?\nFix src/**/*.ts and lib/**/*.ts");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<strong>");
    const out = visible(html);
    expect(out).toContain("2*3*4");
    expect(out).toContain("src/**/*.ts and lib/**/*.ts");
  });

  test("bold the user typed on purpose still renders, also before a full stop", () => {
    expect(renderUser("this is **important** now")).toContain("<strong>important</strong>");
    expect(renderUser("This is **important**.")).toContain("<strong>important</strong>");
    expect(renderUser("Please do it *now*.")).toContain("<em>now</em>");
  });

  test("assistant rendering is unchanged (no literalAsterisks)", () => {
    const html = renderToStaticMarkup(createElement(Markdown, {} as never, "2*3*4"));
    expect(html).toContain("<em>3</em>");
  });
});
