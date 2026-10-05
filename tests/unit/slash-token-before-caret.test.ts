import { describe, expect, test } from "vitest";
import { slashTokenBeforeCaret } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.265 (D4) — the mid-prompt slash picker detects a `/token` under the
 * caret preceded by a boundary, not only a whole-input `/word`. `before` is
 * the text up to the caret.
 */
describe("slashTokenBeforeCaret (CC 2.1.265 — D4)", () => {
  test("detects a leading slash token (first-line case)", () => {
    expect(slashTokenBeforeCaret("/comp")).toBe("comp");
    expect(slashTokenBeforeCaret("/")).toBe("");
  });

  test("detects a slash token mid-prompt after whitespace", () => {
    expect(slashTokenBeforeCaret("please run /depl")).toBe("depl");
    expect(slashTokenBeforeCaret("first line\n/rev")).toBe("rev");
  });

  test("does not fire inside a URL or path (no boundary before the slash)", () => {
    expect(slashTokenBeforeCaret("see https://example.com/x")).toBeNull();
    expect(slashTokenBeforeCaret("open src/app")).toBeNull();
  });

  test("null when the caret is not at the end of a slash token", () => {
    expect(slashTokenBeforeCaret("/deploy now")).toBeNull(); // token already finished
    expect(slashTokenBeforeCaret("plain text")).toBeNull();
  });
});
