import { describe, expect, test } from "vitest";
import {
  BULLET_GLYPH,
  bulletsToMarkdown,
  computeListContinuation,
  isListLine,
} from "@/lib/shared/markdown-list";

/**
 * Pure-function fence around the composer's Slack-style markdown editing.
 *
 * The composer wires these helpers to Enter / Shift+Enter / Tab. The
 * caret math + DOM bits live in `components/chat/PromptInput.tsx` and are
 * covered separately by Playwright; here we only assert the string-level
 * contracts:
 *
 *   - bullet / dash / numbered / checkbox markers are recognised
 *   - the numbered marker increments
 *   - empty list items report `{ kind: "empty" }` so the caller knows to
 *     exit the list instead of inserting another bullet (this is the
 *     behaviour every other markdown editor implements; missing it is the
 *     "I can't escape the list" footgun)
 *   - leading indent is preserved on continuation so nested lists round-trip
 *   - the `•` glyph round-trips to `*` on send so Claude sees real markdown
 */

describe("computeListContinuation", () => {
  test("non-list lines return null", () => {
    expect(computeListContinuation("")).toBeNull();
    expect(computeListContinuation("hello world")).toBeNull();
    expect(computeListContinuation("not a list * here")).toBeNull();
    // Lone `*` without trailing space is emphasis, not a list.
    expect(computeListContinuation("*bold*")).toBeNull();
    // Numeric prefix without `. ` is just text.
    expect(computeListContinuation("123 things")).toBeNull();
  });

  test("bullet markers continue with the same glyph", () => {
    expect(computeListContinuation("• foo")).toEqual({ kind: "next", next: "• " });
    expect(computeListContinuation("* foo")).toEqual({ kind: "next", next: "* " });
    expect(computeListContinuation("- foo")).toEqual({ kind: "next", next: "- " });
  });

  test("numbered list increments", () => {
    expect(computeListContinuation("1. foo")).toEqual({ kind: "next", next: "2. " });
    expect(computeListContinuation("9. foo")).toEqual({ kind: "next", next: "10. " });
    expect(computeListContinuation("42. bar")).toEqual({ kind: "next", next: "43. " });
  });

  test("checkbox lists continue as a fresh unchecked item", () => {
    // Even a checked item rolls over to a blank one — matches GitHub / VS Code:
    // continuing a list shouldn't carry the checked state over to the new item.
    expect(computeListContinuation("- [ ] write tests")).toEqual({
      kind: "next",
      next: "- [ ] ",
    });
    expect(computeListContinuation("- [x] write tests")).toEqual({
      kind: "next",
      next: "- [ ] ",
    });
    expect(computeListContinuation("- [X] write tests")).toEqual({
      kind: "next",
      next: "- [ ] ",
    });
  });

  test("checkbox match wins over the dash-bullet match", () => {
    // Regression guard: if we ever flip the order, `- [ ] foo` would match
    // the plain-bullet branch as `marker='-'` + `content='[ ] foo'`, and we
    // would continue the list with `- ` instead of `- [ ] ` — silently
    // breaking task lists. The order-of-tests assertion is the whole point.
    const result = computeListContinuation("- [ ] task");
    expect(result).toEqual({ kind: "next", next: "- [ ] " });
  });

  test("indent is preserved for nested continuation", () => {
    expect(computeListContinuation("  • nested")).toEqual({ kind: "next", next: "  • " });
    expect(computeListContinuation("    - deep")).toEqual({ kind: "next", next: "    - " });
    expect(computeListContinuation("  1. a")).toEqual({ kind: "next", next: "  2. " });
    expect(computeListContinuation("    - [ ] t")).toEqual({
      kind: "next",
      next: "    - [ ] ",
    });
  });

  test("empty list items report empty so the caller can exit the list", () => {
    expect(computeListContinuation("• ")).toEqual({ kind: "empty" });
    expect(computeListContinuation("* ")).toEqual({ kind: "empty" });
    expect(computeListContinuation("- ")).toEqual({ kind: "empty" });
    expect(computeListContinuation("1. ")).toEqual({ kind: "empty" });
    expect(computeListContinuation("- [ ] ")).toEqual({ kind: "empty" });
    // Trailing whitespace shouldn't fool the empty check — Enter on a
    // visually-empty bullet must still drop us out of the list.
    expect(computeListContinuation("•    ")).toEqual({ kind: "empty" });
    expect(computeListContinuation("  • ")).toEqual({ kind: "empty" });
  });

  test("multiple spaces between marker and content collapse to a single space on continuation", () => {
    // The user's existing item might be `*   foo` (sloppy spacing). We don't
    // mirror that on the next line — every continuation uses the canonical
    // "marker + single space" form, which is what markdown renderers expect.
    expect(computeListContinuation("*   foo")).toEqual({ kind: "next", next: "* " });
    expect(computeListContinuation("1.   foo")).toEqual({ kind: "next", next: "2. " });
  });
});

describe("isListLine", () => {
  test("recognises every supported marker", () => {
    expect(isListLine("• item")).toBe(true);
    expect(isListLine("* item")).toBe(true);
    expect(isListLine("- item")).toBe(true);
    expect(isListLine("1. item")).toBe(true);
    expect(isListLine("- [ ] task")).toBe(true);
    expect(isListLine("- [x] done")).toBe(true);
    expect(isListLine("  • indented")).toBe(true);
  });

  test("rejects non-list content", () => {
    expect(isListLine("")).toBe(false);
    expect(isListLine("hello")).toBe(false);
    expect(isListLine("*bold*")).toBe(false); // no space — emphasis
    expect(isListLine("123")).toBe(false);
    expect(isListLine("-no-space")).toBe(false);
  });
});

describe("bulletsToMarkdown", () => {
  test("rewrites leading bullets line-by-line", () => {
    expect(bulletsToMarkdown("• one\n• two")).toBe("* one\n* two");
  });

  test("preserves indent when converting", () => {
    expect(bulletsToMarkdown("• top\n  • nested\n    • deep")).toBe(
      "* top\n  * nested\n    * deep",
    );
  });

  test("leaves bullets that appear mid-sentence alone", () => {
    // The user might type `•` literally inside a sentence; we only touch
    // the leading-marker form `^(\s*)• ` so prose stays intact.
    expect(bulletsToMarkdown("price • value")).toBe("price • value");
    expect(bulletsToMarkdown("• item\nprice • value")).toBe("* item\nprice • value");
  });

  test("is a no-op on text without bullets", () => {
    expect(bulletsToMarkdown("plain message")).toBe("plain message");
    expect(bulletsToMarkdown("- dash list\n1. numbered")).toBe("- dash list\n1. numbered");
  });

  test("uses the exported glyph so the constant and rewriter stay in sync", () => {
    // If somebody ever swaps `BULLET_GLYPH` for a different character,
    // this test forces them to update the rewriter regex in lockstep —
    // otherwise the composer would display the new glyph but send the
    // old one, and there'd be no failing test to catch it.
    const input = `${BULLET_GLYPH} item`;
    expect(bulletsToMarkdown(input)).toBe("* item");
  });
});
