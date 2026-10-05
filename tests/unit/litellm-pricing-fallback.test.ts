import { describe, expect, test } from "vitest";
import { priceForModel } from "@/lib/server/litellm-pricing";

/**
 * CC 2.1.257 (E1) — the LiteLLM family fallback now covers `fable`, so an
 * offline/pre-refresh Fable model resolves to a Fable price instead of
 * returning undefined (which `costFromUsage` prices at $0).
 */
describe("priceForModel family fallback (E1)", () => {
  const table = {
    "claude-fable-5-1": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00005 },
    "claude-sonnet-5": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
    "claude-opus-5-5": { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002 },
  };

  test("exact-id lookup wins", () => {
    expect(priceForModel("claude-opus-5-5", table)?.input_cost_per_token).toBe(0.000004);
  });

  test("a fable id with no exact key falls back to a claude-fable-* entry (not undefined)", () => {
    const p = priceForModel("claude-fable-5-1-20991231", table);
    expect(p).toBeDefined();
    expect(p?.input_cost_per_token).toBe(0.00001);
  });

  test("a provider-prefixed id resolves via its bare name", () => {
    expect(priceForModel("vertex_ai/claude-sonnet-5", table)?.input_cost_per_token).toBe(0.000002);
  });

  test("an unknown non-Claude model is undefined", () => {
    expect(priceForModel("gpt-4o", table)).toBeUndefined();
  });
});
