import { describe, expect, test } from "vitest";
import { priceFor } from "@/lib/shared/cost-pricing";
import { priceForModel } from "@/lib/server/litellm-pricing";
import { advisorPairingRejected } from "@/lib/shared/advisor";
import bundled from "@/lib/server/litellm-prices.json";

/**
 * CC 2.1.321 — Claude Fable 5.2 (`claude-fable-5-2`) is the new default Fable:
 * 1M context, $8/$40 per Mtok, $0.20 cache reads (engine catalog
 * `tier_8_40_cache_read_0_20`: 5m writes $10, 1h writes $16), advisor rank 10.
 */
describe("Fable 5.2 pricing", () => {
  test("browser estimator prices Fable 5.2 at $8/$40, not Fable 5.1's $10/$50", () => {
    for (const id of ["claude-fable-5-2", "us.anthropic.claude-fable-5-2", "claude-fable-5.2"]) {
      const p = priceFor(id);
      expect([p.input, p.output, p.cacheRead, p.cacheWrite5m, p.cacheWrite1h]).toEqual([8, 40, 0.2, 10, 16]);
    }
  });

  test("Fable 5.1 keeps its own price", () => {
    const p = priceFor("claude-fable-5-1");
    expect([p.input, p.output, p.cacheRead]).toEqual([10, 50, 0.25]);
  });

  test("the bundled LiteLLM snapshot resolves Fable 5.2 to its own entry, not Fable 5's", () => {
    const table = bundled as unknown as Parameters<typeof priceForModel>[1];
    const p = priceForModel("claude-fable-5-2", table);
    expect(p?.input_cost_per_token).toBe(0.000008);
    expect(p?.output_cost_per_token).toBe(0.00004);
    expect(p?.cache_read_input_token_cost).toBe(2e-7);
    // A provider-wrapped id finds the same entry via the canonical-key scan.
    expect(priceForModel("us.anthropic.claude-fable-5-2-v1:0", table)?.input_cost_per_token).toBe(0.000008);
  });
});

describe("Fable 5.2 advisor pairing (rank 10)", () => {
  test("a Fable 5.2 session refuses every lower-ranked advisor", () => {
    for (const adv of ["claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(advisorPairingRejected("claude-fable-5-2", adv)).toBe(true);
    }
  });

  test("Fable 5.2 and Mythos 5.2 can advise a Fable 5.2 session", () => {
    expect(advisorPairingRejected("claude-fable-5-2", "claude-fable-5-2")).toBe(false);
    expect(advisorPairingRejected("claude-fable-5-2", "claude-mythos-5-2")).toBe(false);
    expect(advisorPairingRejected("claude-mythos-5-2", "claude-fable-5-2")).toBe(false);
  });

  test("a Fable 5.2 advisor is accepted for every lower-ranked executor", () => {
    for (const exec of [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-opus-4-8",
      "claude-opus-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
    ]) {
      expect(advisorPairingRejected(exec, "claude-fable-5-2")).toBe(false);
    }
  });
});
