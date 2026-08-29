/**
 * CC parity 2.1.251 — pure derivation behind the CostOverlay's "Prompt cache"
 * line (hit ratio, misses, tokens re-cached, warm/cold). See
 * lib/shared/prompt-cache.ts for why this is computed client-side instead of
 * threaded through a new SSE field.
 */
import { describe, expect, test } from "vitest";
import { computePromptCacheStats } from "@/lib/shared/prompt-cache";

describe("computePromptCacheStats", () => {
  test("no prompt tokens yet — ratios are null, cold", () => {
    const stats = computePromptCacheStats({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(stats).toEqual({
      hitRatioPct: null,
      missRatioPct: null,
      tokensRecached: 0,
      cacheWriteTokens: 0,
      warm: false,
    });
  });

  test("all-miss first turn — cold, 0% hit ratio", () => {
    const stats = computePromptCacheStats({
      inputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 500,
    });
    expect(stats.hitRatioPct).toBe(0);
    expect(stats.missRatioPct).toBe(100);
    expect(stats.warm).toBe(false);
    expect(stats.cacheWriteTokens).toBe(500);
  });

  test("mixed hit/miss — warm, ratio reflects cache-read share", () => {
    const stats = computePromptCacheStats({
      inputTokens: 50,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
    });
    // total = 1000, hit ratio = 900/1000 = 90%
    expect(stats.hitRatioPct).toBe(90);
    expect(stats.missRatioPct).toBe(10);
    expect(stats.tokensRecached).toBe(900);
    expect(stats.warm).toBe(true);
  });

  test("fully warm — 100% hit ratio", () => {
    const stats = computePromptCacheStats({
      inputTokens: 0,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0,
    });
    expect(stats.hitRatioPct).toBe(100);
    expect(stats.missRatioPct).toBe(0);
    expect(stats.warm).toBe(true);
  });

  test("negative inputs (defensive) are clamped to zero", () => {
    const stats = computePromptCacheStats({
      inputTokens: -5,
      cacheReadInputTokens: -1,
      cacheCreationInputTokens: -1,
    });
    expect(stats).toEqual({
      hitRatioPct: null,
      missRatioPct: null,
      tokensRecached: 0,
      cacheWriteTokens: 0,
      warm: false,
    });
  });
});
