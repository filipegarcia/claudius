import { describe, expect, test } from "vitest";
import { fuzzySlashMatchIndices } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.227 parity: "Improved slash-command menu: ... matched characters
 * are bolded instead of recolored." `fuzzySlashMatchIndices` is the pure
 * half of that — it returns which character positions in a command name
 * matched the typed filter, so `SlashCommandPicker` can bold them.
 */
describe("fuzzySlashMatchIndices", () => {
  test("empty filter has no highlight", () => {
    expect(fuzzySlashMatchIndices("", "cost")).toBeNull();
  });

  test("a contiguous prefix match highlights the leading run", () => {
    expect(fuzzySlashMatchIndices("co", "cost")).toEqual([0, 1]);
  });

  test("a contiguous mid-string match highlights that run", () => {
    expect(fuzzySlashMatchIndices("view", "worktrees-view")).toEqual([10, 11, 12, 13]);
  });

  test("a subsequence-only match highlights the scattered characters", () => {
    // "gt" is a subsequence of "git" (g...t), not a contiguous substring.
    expect(fuzzySlashMatchIndices("gt", "git")).toEqual([0, 2]);
  });

  test("no match at all returns null", () => {
    expect(fuzzySlashMatchIndices("xyz", "cost")).toBeNull();
  });

  test("is case-insensitive", () => {
    expect(fuzzySlashMatchIndices("CO", "cost")).toEqual([0, 1]);
  });

  // CC 2.1.227's own changelog line pairs "matched characters are bolded"
  // with "emoji or accented names keep their glyphs" — regression coverage
  // for the first cut of this fix, which used UTF-16-code-unit indices
  // (`.split("")` in the renderer) and would have split a surrogate pair or
  // separated a base character from its combining accent across a
  // matched/unmatched boundary. Indices here are code-point offsets;
  // `Array.from` in the renderer is what makes that safe to slice on.
  test("indices are code points, not UTF-16 code units, for a surrogate-pair emoji", () => {
    // "🚀" is one code point but two UTF-16 code units. A code-unit-based
    // implementation would report matches at indices past where the emoji
    // actually ends.
    const name = "🚀deploy";
    expect(Array.from(name).length).toBe(7); // 1 (emoji) + 6 ("deploy")
    expect(fuzzySlashMatchIndices("deploy", name)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("an NFD-decomposed accented name matches on code points, keeping the combining mark out of the boundary", () => {
    // "café" spelled as base "e" (U+0065) + combining acute (U+0301) — 5
    // code points for 4 visible glyphs. A UTF-16-code-unit split is
    // actually identical in length here (no surrogate pairs), so this only
    // matters when paired with the emoji case above, but it documents the
    // NFD shape explicitly since it's the concrete example called out in
    // review (APFS/HFS+ commonly yields NFD filenames).
    const nfd = "café";
    expect(Array.from(nfd).length).toBe(5);
    expect(fuzzySlashMatchIndices("cafe", nfd)).toEqual([0, 1, 2, 3]);
  });
});
