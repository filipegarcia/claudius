import { describe, expect, test } from "vitest";
import { normalizeDottedModelVersion } from "@/lib/shared/model-id";
import { priceFor } from "@/lib/shared/cost-pricing";
import { priceForModel, type LiteLlmPricing, type PricingTable } from "@/lib/server/litellm-pricing";
import { matchModelPricingRate } from "@/lib/server/model-pricing-override";

/**
 * CC 2.1.314 — "Fixed model IDs spelled with a dot behind an LLM gateway,
 * such as `claude-opus-4.8`, being treated as an older model with the wrong
 * … cost". Claudius's pricing tables are its own code; a dotted id must price
 * exactly like its dashed spelling.
 */

describe("normalizeDottedModelVersion", () => {
  test.each([
    ["claude-opus-4.8", "claude-opus-4-8"],
    ["claude-opus-5.5", "claude-opus-5-5"],
    ["claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["claude-haiku-5.5", "claude-haiku-5-5"],
    ["claude-fable-5.1", "claude-fable-5-1"],
    ["anthropic/claude-opus-4.8", "anthropic/claude-opus-4-8"],
    ["CLAUDE-OPUS-5.5", "CLAUDE-OPUS-5-5"],
    ["sonnet-5.5", "sonnet-5-5"],
    ["fable-5.1", "fable-5-1"],
    ["anthropic/sonnet-5.5", "anthropic/sonnet-5-5"],
  ])("%s → %s", (input, out) => {
    expect(normalizeDottedModelVersion(input)).toBe(out);
  });

  test.each([
    "us.anthropic.claude-sonnet-5-5-v1:0",
    "anthropic.claude-opus-4-8-v1:0",
    "claude-2.1",
    "claude-instant-1.2",
    "claude-opus-4-5-20251101",
    "gpt-4.1",
    "claude-3.5-sonnet",
  ])("leaves %s alone", (id) => {
    expect(normalizeDottedModelVersion(id)).toBe(id);
  });
});

describe("priceFor (browser estimator) — dotted == dashed", () => {
  test.each([
    ["claude-opus-5.5", "claude-opus-5-5"],
    ["claude-opus-4.8", "claude-opus-4-8"],
    ["claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["claude-haiku-5.5", "claude-haiku-5-5"],
    ["claude-fable-5.1", "claude-fable-5-1"],
    ["fable-5.1", "fable-5-1"],
    ["sonnet-5.5", "sonnet-5-5"],
  ])("%s prices like %s", (dotted, dashed) => {
    expect(priceFor(dotted)).toEqual(priceFor(dashed));
  });

  test("claude-opus-5.5 is no longer priced as Opus 5", () => {
    expect(priceFor("claude-opus-5.5")).not.toEqual(priceFor("claude-opus-5"));
  });
});

function entry(input: number): LiteLlmPricing {
  return { input_cost_per_token: input / 1e6, output_cost_per_token: (input * 5) / 1e6 } as LiteLlmPricing;
}

// Explicit fixture (not the bundle / ~/.claude overlay) with an older and a
// newer key per family, so a fall-through to the older entry is visible.
const table: PricingTable = {
  "claude-opus-5": entry(5),
  "claude-opus-5-5": entry(4),
  "claude-haiku-4-5": entry(1),
  "claude-haiku-5-5": entry(0.1),
  "claude-sonnet-5": entry(2),
  "claude-sonnet-5-5": entry(2.5),
  "claude-fable-5": entry(10),
  "claude-fable-5-1": entry(11),
  "openrouter/anthropic/claude-opus-4.6": entry(7),
};

describe("priceForModel (LiteLLM table) — dotted == dashed", () => {
  test.each([
    ["claude-opus-5.5", "claude-opus-5-5"],
    ["claude-haiku-5.5", "claude-haiku-5-5"],
    ["claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["claude-fable-5.1", "claude-fable-5-1"],
    ["litellm_proxy/claude-opus-5.5", "claude-opus-5-5"],
  ])("%s resolves to %s", (dotted, key) => {
    expect(priceForModel(dotted, table)).toBe(table[key]);
  });

  test("a dotted aggregator key still matches exactly", () => {
    expect(priceForModel("openrouter/anthropic/claude-opus-4.6", table)).toBe(
      table["openrouter/anthropic/claude-opus-4.6"],
    );
  });
});

describe("matchModelPricingRate — per-model overrides match either spelling", () => {
  const dashedRates = { "claude-opus-4-8": { input: 1 } };
  const dottedRates = { "claude-opus-4.8": { input: 2 } };

  test("a dashed rate key covers a gateway's dotted id", () => {
    expect(matchModelPricingRate("claude-opus-4.8", dashedRates)).toBe(dashedRates["claude-opus-4-8"]);
  });

  test("a dotted rate key covers the dashed id", () => {
    expect(matchModelPricingRate("claude-opus-4-8-20260101", dottedRates)).toBe(dottedRates["claude-opus-4.8"]);
  });
});
