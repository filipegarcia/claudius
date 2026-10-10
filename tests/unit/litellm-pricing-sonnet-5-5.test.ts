import { describe, expect, test } from "vitest";
import { costFromUsage, priceForModel, type LiteLlmPricing } from "@/lib/server/litellm-pricing";
import bundled from "@/lib/server/litellm-prices.json";

/**
 * CC 2.1.296 — "/cost, the status line, --max-budget-usd and the SDK's cost
 * figures price Sonnet 5.5 cache reads at $0.10 per million tokens (was
 * $0.20)". Claudius's server-side cost page prices from the bundled LiteLLM
 * snapshot, so its Sonnet 5.5 entry carries the new rate; Sonnet 5 keeps $0.20.
 */
const table = bundled as Record<string, LiteLlmPricing>;

describe("bundled LiteLLM snapshot — Sonnet 5.5 cache reads (CC 2.1.296)", () => {
  test("Sonnet 5.5 cache read is $0.10/MT", () => {
    expect(table["claude-sonnet-5-5"].cache_read_input_token_cost).toBeCloseTo(0.1e-6, 12);
  });

  test("Sonnet 5 cache read stays $0.20/MT", () => {
    expect(table["claude-sonnet-5"].cache_read_input_token_cost).toBeCloseTo(0.2e-6, 12);
  });

  test("a provider-wrapped Sonnet 5.5 id resolves to the repriced entry", () => {
    const p = priceForModel("us.anthropic.claude-sonnet-5-5-v1:0", table);
    // 1M cache-read tokens → $0.10.
    expect(costFromUsage(p, { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0 })).toBeCloseTo(0.1, 6);
  });
});
