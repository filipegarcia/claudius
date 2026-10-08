import { describe, expect, test } from "vitest";
import { costFromUsage, priceForModel, type LiteLlmPricing } from "@/lib/server/litellm-pricing";
import bundled from "@/lib/server/litellm-prices.json";

/**
 * CC 2.1.293 — Claude Haiku 5.5 (`claude-haiku-5-5`), $0.10/$0.50 per Mtok,
 * $0.50/$2.50 for prompts over 100K. Before this, the server pricer had no
 * Haiku 5.5 entry and its family fallback returned the first `claude-haiku…`
 * key — Haiku 4.5, at ten times the price.
 */

const HAIKU_45: LiteLlmPricing = { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 };
const HAIKU_55: LiteLlmPricing = {
  input_cost_per_token: 1e-7,
  output_cost_per_token: 5e-7,
  cache_read_input_token_cost: 1e-8,
  cache_creation_input_token_cost: 1.25e-7,
  input_cost_per_token_above_100k_tokens: 5e-7,
  output_cost_per_token_above_100k_tokens: 2.5e-6,
  cache_read_input_token_cost_above_100k_tokens: 5e-8,
  cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
};
const SONNET_45_LIKE: LiteLlmPricing = {
  input_cost_per_token: 3e-6,
  output_cost_per_token: 15e-6,
  input_cost_per_token_above_200k_tokens: 6e-6,
  output_cost_per_token_above_200k_tokens: 22.5e-6,
};
// Haiku 4.5 listed first, as in the bundled snapshot.
const table = { "claude-haiku-4-5": HAIKU_45, "claude-haiku-5-5": HAIKU_55, "claude-sonnet-4-5": SONNET_45_LIKE };

describe("priceForModel — Haiku 5.5 (CC 2.1.293)", () => {
  test("the bundled snapshot prices Haiku 5.5 at $0.10/$0.50 with a 100K tier", () => {
    const entry = (bundled as Record<string, LiteLlmPricing>)["claude-haiku-5-5"];
    expect(entry.input_cost_per_token).toBeCloseTo(0.1e-6, 12);
    expect(entry.output_cost_per_token).toBeCloseTo(0.5e-6, 12);
    expect(entry.input_cost_per_token_above_100k_tokens).toBeCloseTo(0.5e-6, 12);
    expect(entry.output_cost_per_token_above_100k_tokens).toBeCloseTo(2.5e-6, 12);
  });

  test("provider-wrapped and suffixed ids resolve to Haiku 5.5, not the first haiku key", () => {
    expect(priceForModel("us.anthropic.claude-haiku-5-5-v1:0", table)).toBe(HAIKU_55);
    expect(priceForModel("claude-haiku-5-5[1m]", table)).toBe(HAIKU_55);
    expect(priceForModel("claude-haiku-5-5", table)).toBe(HAIKU_55);
  });

  test("Haiku 4.5 ids still resolve to Haiku 4.5", () => {
    expect(priceForModel("claude-haiku-4-5-20251001", table)).toBe(HAIKU_45);
    expect(priceForModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0", table)).toBe(HAIKU_45);
  });
});

describe("costFromUsage long-context tiers", () => {
  const usage = (input: number) => ({ input, output: 1_000, cacheRead: 0, cacheCreation: 0 });

  test("Haiku 5.5 bills a turn over 100K at the 100K tier, including past 200K", () => {
    expect(costFromUsage(HAIKU_55, usage(50_000))).toBeCloseTo(50_000 * 1e-7 + 1_000 * 5e-7, 10);
    expect(costFromUsage(HAIKU_55, usage(150_000))).toBeCloseTo(150_000 * 5e-7 + 1_000 * 2.5e-6, 10);
    expect(costFromUsage(HAIKU_55, usage(250_000))).toBeCloseTo(250_000 * 5e-7 + 1_000 * 2.5e-6, 10);
  });

  test("cache reads count toward the footprint and take the tier rate", () => {
    const u = { input: 1_000, output: 0, cacheRead: 120_000, cacheCreation: 0 };
    expect(costFromUsage(HAIKU_55, u)).toBeCloseTo(1_000 * 5e-7 + 120_000 * 5e-8, 10);
  });

  test("a model with only a 200K tier is unchanged between 100K and 200K", () => {
    expect(costFromUsage(SONNET_45_LIKE, usage(150_000))).toBeCloseTo(150_000 * 3e-6 + 1_000 * 15e-6, 10);
    expect(costFromUsage(SONNET_45_LIKE, usage(250_000))).toBeCloseTo(250_000 * 6e-6 + 1_000 * 22.5e-6, 10);
  });
});
