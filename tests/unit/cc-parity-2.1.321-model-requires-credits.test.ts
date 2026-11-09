import { describe, expect, test } from "vitest";
import { matchesUsageLimitPrefix } from "@/lib/shared/rate-limit-prefixes";

/**
 * CC 2.1.321 — the engine names the model in its "requires usage credits"
 * limit text (`${displayName} requires usage credits.`). The fixed
 * "Fable 5 requires usage credits" prefix missed the new default Fable.
 */
describe("model-named 'requires usage credits' limit text", () => {
  test("matches any model name the engine emits", () => {
    for (const t of [
      "Fable 5.2 requires usage credits. Turn them on in Settings to keep going.",
      "Fable requires usage credits.",
      "Mythos 5.2 requires usage credits.",
      "Opus 5.5 requires usage credits. Run /usage to set it up.",
    ]) {
      expect(matchesUsageLimitPrefix(t), t).toBe(true);
    }
  });

  test("the existing Fable 5 prefix still matches", () => {
    expect(matchesUsageLimitPrefix("Fable 5 requires usage credits")).toBe(true);
  });

  test("ordinary prose that mentions it is not a limit hit", () => {
    for (const t of [
      "Note: Fable 5.2 requires usage credits.",
      "The Fable model requires usage credits on some plans",
      "Fable 5.2 requires usage credits on Team plans, so I used Opus",
      "Gemini 2 requires usage credits.",
      "fable 5.2 requires usage credits.", // engine pattern is case-sensitive
    ]) {
      expect(matchesUsageLimitPrefix(t), t).toBe(false);
    }
  });
});
