import { describe, expect, test } from "vitest";
import {
  applyModelPricing,
  costFromOverrideRate,
  hasModelPricingOverride,
  matchModelPricingRate,
} from "@/lib/server/model-pricing-override";

/**
 * Pure-function coverage for the `modelPricing` setting (Claude Code
 * 2.1.243 — "an organization's contracted per-model rates and discount
 * multiplier are used for /cost... instead of list price").
 */

describe("matchModelPricingRate", () => {
  test("exact key wins over a looser family match", () => {
    const rates = {
      opus: { input: 10 },
      "claude-opus-4-8": { input: 9 },
    };
    expect(matchModelPricingRate("claude-opus-4-8", rates)?.input).toBe(9);
  });

  test("falls back to a case-insensitive substring match", () => {
    const rates = { opus: { input: 10 } };
    expect(matchModelPricingRate("claude-OPUS-4-8", rates)?.input).toBe(10);
  });

  test("returns undefined when nothing matches", () => {
    expect(matchModelPricingRate("claude-sonnet-5", { opus: { input: 10 } })).toBeUndefined();
    expect(matchModelPricingRate("claude-sonnet-5", undefined)).toBeUndefined();
  });
});

describe("costFromOverrideRate", () => {
  test("computes $/MT rates against token counts", () => {
    const usd = costFromOverrideRate(
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 },
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    );
    expect(usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
  });

  test("treats missing rate fields as zero", () => {
    const usd = costFromOverrideRate(
      { input: 3 },
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    );
    expect(usd).toBeCloseTo(3, 10);
  });
});

describe("applyModelPricing", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

  test("returns the base cost unchanged when no setting is configured", () => {
    expect(applyModelPricing(1.23, "claude-opus-4-8", tokens, undefined)).toBe(1.23);
  });

  test("a matched per-model rate REPLACES the base cost (list price or authoritative JSONL cost)", () => {
    const usd = applyModelPricing(1.23 /* would-be list price */, "claude-opus-4-8", tokens, {
      rates: { opus: { input: 9 } },
    });
    expect(usd).toBeCloseTo(9, 10); // 1M input tokens @ $9/MT, not 1.23
  });

  test("an unmatched model keeps the base cost, but the discount multiplier still applies", () => {
    const usd = applyModelPricing(10, "claude-haiku-4-5", tokens, {
      rates: { opus: { input: 9 } },
      discountMultiplier: 0.9,
    });
    expect(usd).toBeCloseTo(9, 10); // 10 * 0.9, no rate match
  });

  test("discount multiplier applies on top of a matched rate", () => {
    const usd = applyModelPricing(1.23, "claude-opus-4-8", tokens, {
      rates: { opus: { input: 10 } },
      discountMultiplier: 0.5,
    });
    expect(usd).toBeCloseTo(5, 10); // 10 * 0.5
  });

  test("ignores a non-positive or non-finite discount multiplier", () => {
    expect(applyModelPricing(10, "x", tokens, { discountMultiplier: 0 })).toBe(10);
    expect(applyModelPricing(10, "x", tokens, { discountMultiplier: -1 })).toBe(10);
    expect(applyModelPricing(10, "x", tokens, { discountMultiplier: Infinity })).toBe(10);
  });
});

describe("hasModelPricingOverride", () => {
  test("false for undefined/empty settings", () => {
    expect(hasModelPricingOverride(undefined)).toBe(false);
    expect(hasModelPricingOverride({})).toBe(false);
    expect(hasModelPricingOverride({ rates: {} })).toBe(false);
  });

  test("true when a rate or a positive discount is configured", () => {
    expect(hasModelPricingOverride({ rates: { opus: { input: 1 } } })).toBe(true);
    expect(hasModelPricingOverride({ discountMultiplier: 0.9 })).toBe(true);
    expect(hasModelPricingOverride({ discountMultiplier: 0 })).toBe(false);
  });
});
