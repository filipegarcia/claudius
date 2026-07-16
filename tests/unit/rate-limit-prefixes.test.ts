import { describe, expect, test } from "vitest";
import { matchesUsageLimitPrefix, USAGE_LIMIT_ERROR_PREFIXES } from "@/lib/shared/rate-limit-prefixes";

describe("matchesUsageLimitPrefix", () => {
  test("matches every entry in USAGE_LIMIT_ERROR_PREFIXES verbatim", () => {
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
      expect(matchesUsageLimitPrefix(prefix)).toBe(true);
      expect(matchesUsageLimitPrefix(`${prefix} · resets 8:10pm`)).toBe(true);
    }
  });

  test("normalizes a curly apostrophe to straight before matching", () => {
    expect(matchesUsageLimitPrefix("You’ve hit your weekly limit")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(matchesUsageLimitPrefix("you've hit your weekly limit")).toBe(true);
    expect(matchesUsageLimitPrefix("YOU'RE OUT OF USAGE CREDITS")).toBe(true);
  });

  test("trims leading/trailing whitespace before matching", () => {
    expect(matchesUsageLimitPrefix("   You've hit your session limit  ")).toBe(true);
  });

  test("does not match normal prose that merely mentions limits", () => {
    expect(matchesUsageLimitPrefix("Let me check whether we hit your rate limit earlier.")).toBe(false);
    expect(matchesUsageLimitPrefix("You've reached the end of the file.")).toBe(false);
    expect(matchesUsageLimitPrefix("The function enforces a 5-hour limit on the cache.")).toBe(false);
    expect(matchesUsageLimitPrefix("")).toBe(false);
  });
});
