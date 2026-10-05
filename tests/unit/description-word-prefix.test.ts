import { describe, expect, test } from "vitest";
import { descriptionWordPrefixScore } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.286 (D9) — the slash picker matches a command's description by word
 * prefix, not a loose letter-subsequence (which surfaced unrelated commands
 * for short queries).
 */
describe("descriptionWordPrefixScore (CC 2.1.286 — D9)", () => {
  const desc = "Summarize earlier turns to free up context";

  test("matches when the query prefixes a word in the description", () => {
    expect(descriptionWordPrefixScore("sum", desc)).toBeGreaterThan(0); // Summarize
    expect(descriptionWordPrefixScore("context", desc)).toBeGreaterThan(0);
    expect(descriptionWordPrefixScore("free", desc)).toBeGreaterThan(0);
  });

  test("does NOT match a loose subsequence spanning words (the bug being fixed)", () => {
    // "sce" is a subsequence of "Summarize…context" but prefixes no word.
    expect(descriptionWordPrefixScore("sce", desc)).toBe(0);
    // "co" is NOT a prefix of any word except "context"? -> it is ("context").
    // Use a genuine non-word-prefix: "ntext" is inside "context" but not a prefix.
    expect(descriptionWordPrefixScore("ntext", desc)).toBe(0);
  });

  test("empty filter scores 0", () => {
    expect(descriptionWordPrefixScore("", desc)).toBe(0);
  });

  test("ranks below a name prefix match (so names win)", () => {
    // fuzzyScore name-prefix is 100; this stays modest.
    expect(descriptionWordPrefixScore("sum", desc)).toBeLessThan(100);
  });
});
