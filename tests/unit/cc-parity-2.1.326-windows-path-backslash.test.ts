import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { preserveLoneBackslashes } from "@/lib/shared/lone-backslash";

/**
 * CC 2.1.326 parity — "Fixed Windows paths in Claude's responses losing the
 * backslash before folders like `.claude` or `_build`".
 */

const render = (text: string, math = true): string =>
  renderToStaticMarkup(createElement(Markdown, { math } as { math: boolean; children: string }, text));

/** Visible text of the rendered HTML (tags skipped with a scanner, entities decoded). */
const visible = (html: string): string => {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
};

describe("preserveLoneBackslashes — Windows path separators", () => {
  test("doubles the separator before a folder that starts with punctuation", () => {
    expect(preserveLoneBackslashes("Open C:\\Users\\me\\.claude now")).toBe("Open C:\\Users\\me\\\\.claude now");
    expect(preserveLoneBackslashes("Delete D:\\repo\\_build first")).toBe("Delete D:\\repo\\\\_build first");
    expect(preserveLoneBackslashes("C:\\.claude")).toBe("C:\\\\.claude");
    expect(preserveLoneBackslashes("C:\\a\\.git\\-x")).toBe("C:\\a\\\\.git\\\\-x");
  });

  test("other Windows path starts are recognised", () => {
    expect(preserveLoneBackslashes("%USERPROFILE%\\.claude")).toBe("%USERPROFILE%\\\\.claude");
    expect(preserveLoneBackslashes("~\\.config")).toBe("~\\\\.config");
    expect(preserveLoneBackslashes(".\\_build\\out")).toBe(".\\\\_build\\out");
    expect(preserveLoneBackslashes("**C:\\x\\.vscode**")).toBe("**C:\\x\\\\.vscode**");
  });

  test("emphasis escapes outside a Windows path are left alone", () => {
    for (const s of ["snake\\_case", "a \\_b\\_ c", "\\*not bold\\*", "1\\. not a list", "end\\."]) {
      expect(preserveLoneBackslashes(s)).toBe(s);
    }
  });

  test("code, URLs and already-doubled separators are untouched", () => {
    for (const s of [
      "run `C:\\Users\\me\\.claude` now",
      "```\nC:\\repo\\_build\n```",
      "see file://C:\\x\\.claude ok",
      "C:\\\\Users\\\\.claude",
      "> C:\\x\\.claude",
    ]) {
      expect(preserveLoneBackslashes(s)).toBe(s);
    }
  });
});

describe("Markdown renders Windows paths as written", () => {
  test(".claude and _build keep their backslash", () => {
    const out = visible(render("Settings live in C:\\Users\\me\\.claude and output in D:\\repo\\_build."));
    expect(out).toContain("C:\\Users\\me\\.claude");
    expect(out).toContain("D:\\repo\\_build");
  });

  test("also without math (user-side rendering)", () => {
    expect(visible(render("C:\\Users\\me\\.claude", false))).toContain("C:\\Users\\me\\.claude");
  });

  test("an escaped underscore in prose still escapes emphasis", () => {
    const html = render("snake\\_case\\_name");
    expect(html).not.toContain("<em>");
    expect(visible(html)).toContain("snake_case_name");
  });
});
