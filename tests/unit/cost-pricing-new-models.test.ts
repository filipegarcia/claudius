import { describe, expect, test } from "vitest";
import { inferenceGeoMultiplier, priceFor } from "@/lib/shared/cost-pricing";

/**
 * CC 2.1.257/2.1.284/2.1.219/2.1.280 (E1) — the browser cost estimator prices
 * current-gen models correctly instead of billing every opus at $15/$75, every
 * sonnet at $3/$15, and fable at Sonnet rates.
 */
describe("priceFor — current-generation models (E1)", () => {
  test("Opus 5.5 is $4/$20, cache read $0.20 (not legacy $15/$75)", () => {
    const p = priceFor("claude-opus-5-5");
    expect([p.input, p.output, p.cacheRead]).toEqual([4, 20, 0.2]);
  });

  test("Opus 5 is $5/$25", () => {
    const p = priceFor("claude-opus-5");
    expect([p.input, p.output, p.cacheRead]).toEqual([5, 25, 0.5]);
  });

  test("Sonnet 5 and 5.5 are $2/$10, cache read $0.20", () => {
    for (const id of ["claude-sonnet-5", "claude-sonnet-5-5"]) {
      const p = priceFor(id);
      expect([p.input, p.output, p.cacheRead]).toEqual([2, 10, 0.2]);
    }
  });

  test("Fable 5.1 is $10/$50, cache read $0.25 (not Sonnet rates)", () => {
    const p = priceFor("claude-fable-5-1");
    expect([p.input, p.output, p.cacheRead]).toEqual([10, 50, 0.25]);
  });

  test("legacy families still fall back to their generic price", () => {
    expect(priceFor("claude-opus-4-1").input).toBe(15);
    expect(priceFor("claude-sonnet-4-6").input).toBe(3);
    expect(priceFor("claude-haiku-4-5").input).toBe(1);
    expect(priceFor("something-unknown").input).toBe(3); // sonnet default
  });

  test("opus-5-5 is matched before the broader opus-5 / opus rules", () => {
    expect(priceFor("claude-opus-5-5").input).toBe(4);
    expect(priceFor("claude-opus-5").input).toBe(5);
    expect(priceFor("claude-opus-4-8").input).toBe(15);
  });
});

describe("inferenceGeoMultiplier (CC 2.1.239 — E12)", () => {
  test("US-only inference carries a 1.1x premium", () => {
    expect(inferenceGeoMultiplier("us")).toBe(1.1);
    expect(inferenceGeoMultiplier("US")).toBe(1.1);
  });

  test("other regions / not_available / null carry no premium", () => {
    expect(inferenceGeoMultiplier("not_available")).toBe(1);
    expect(inferenceGeoMultiplier("eu")).toBe(1);
    expect(inferenceGeoMultiplier(null)).toBe(1);
    expect(inferenceGeoMultiplier(undefined)).toBe(1);
  });
});

describe("priceFor — Haiku 5.5 (CC 2.1.293)", () => {
  test("Haiku 5.5 is $0.10/$0.50, cache read $0.01", () => {
    const p = priceFor("claude-haiku-5-5");
    expect([p.input, p.output, p.cacheRead]).toEqual([0.1, 0.5, 0.01]);
  });

  test("Haiku 4.5 keeps the $1/$5 rate", () => {
    const p = priceFor("claude-haiku-4-5");
    expect([p.input, p.output]).toEqual([1, 5]);
  });
});
