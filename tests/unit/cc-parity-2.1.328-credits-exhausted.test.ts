import { describe, expect, test } from "vitest";
import { rateLimitHitFromBlocks } from "@/lib/client/use-session";
import { rateLimitCtaKind } from "@/lib/client/rate-limit-cta";
import { isCreditsExhaustedText, matchesUsageLimitPrefix } from "@/lib/shared/rate-limit-prefixes";

/**
 * CC 2.1.328 — "Fixed the error shown when usage credits run out
 * mid-response, which named a rate limit".
 *
 * The engine ends that turn with "You're out of usage credits" (plus an
 * optional " · resets <time>" / " · progress saved"). Claudius's limit panel
 * put "You've hit your 5-hour limit" and a reset countdown from an earlier
 * rate_limit_event under it, then offered plan upgrades.
 */
const block = (text: string) => [{ kind: "text" as const, text }];
const LAST = { rateLimitType: "five_hour", resetsAt: 1_900_000_000, canUserPurchaseCredits: true } as never;

describe("isCreditsExhaustedText", () => {
  test("matches the engine's exact text, with either apostrophe", () => {
    expect(isCreditsExhaustedText("You're out of usage credits")).toBe(true);
    expect(isCreditsExhaustedText("You’re out of usage credits · resets 4pm · progress saved")).toBe(true);
    expect(matchesUsageLimitPrefix("You're out of usage credits · resets 4pm")).toBe(true);
  });
  test("does not match a plan window that adds a credits note, or other text", () => {
    expect(isCreditsExhaustedText("You've hit your 5-hour limit · resets 4pm · out of usage credits")).toBe(false);
    expect(isCreditsExhaustedText("Your org is out of usage · add funds to continue")).toBe(false);
    expect(isCreditsExhaustedText("you're out of usage credits")).toBe(false);
  });
});

describe("rateLimitHitFromBlocks — credits exhausted", () => {
  test("no tier or reset from the earlier event; keeps purchase + plan signals", () => {
    const hit = rateLimitHitFromBlocks(block("You're out of usage credits · resets 4pm"), LAST, "claude-sonnet-5-5", "max");
    expect(hit).toEqual({ creditsExhausted: true, canUserPurchaseCredits: true, subscriptionType: "max" });
    expect(rateLimitCtaKind(hit)).toBe("credits-exhausted");
  });

  test("replay/pagination (no event) gives the same panel", () => {
    expect(rateLimitHitFromBlocks(block("You're out of usage credits"), null, null)).toEqual({ creditsExhausted: true });
  });

  test("a seat that can't buy credits is pointed at its admin", () => {
    const hit = rateLimitHitFromBlocks(
      block("You're out of usage credits"),
      { canUserPurchaseCredits: false } as never,
      null,
      "team",
    );
    expect(rateLimitCtaKind(hit)).toBe("contact-admin-credits");
  });

  test("a plan window with a credits note keeps its tier and reset", () => {
    const hit = rateLimitHitFromBlocks(
      block("You've hit your 5-hour limit · resets 4pm · out of usage credits"),
      LAST,
      null,
      "max",
    );
    expect(hit.creditsExhausted).toBeUndefined();
    expect(hit.rateLimitType).toBe("five_hour");
    expect(hit.resetsAt).toBe(1_900_000_000);
  });
});
