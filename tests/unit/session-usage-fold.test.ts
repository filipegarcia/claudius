import { describe, expect, test } from "vitest";

import {
  addSessionUsage,
  foldResultIntoSessionUsage,
  mergeModelUsage,
  zeroSessionUsage,
} from "@/lib/server/session";
import type { SessionUsageTotals } from "@/lib/shared/events";

/**
 * SDK `result` fields (`total_cost_usd`, `num_turns`, durations,
 * `modelUsage`) are RUNNING TOTALS per SDK process in streaming-input
 * sessions — verified empirically (consecutive results carried num_turns
 * 6→19 and total_cost_usd 14.22→16.48 matching the cumulative modelUsage
 * cost sums). These tests pin the accumulator model:
 * totals = persisted baseline + latest running block, with /clear-style
 * resets banked into the baseline and zeroed crash frames ignored.
 */

function resultMsg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0,
    num_turns: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    ...over,
  };
}

function mu(models: Record<string, { in?: number; out?: number; cr?: number; cc?: number; cost?: number }>) {
  return Object.fromEntries(
    Object.entries(models).map(([k, v]) => [
      k,
      {
        inputTokens: v.in ?? 0,
        outputTokens: v.out ?? 0,
        cacheReadInputTokens: v.cr ?? 0,
        cacheCreationInputTokens: v.cc ?? 0,
        webSearchRequests: 0,
        costUSD: v.cost ?? 0,
        contextWindow: 200000,
      },
    ]),
  );
}

describe("foldResultIntoSessionUsage", () => {
  test("consecutive cumulative results do NOT sum — latest running total wins", () => {
    let baseline = zeroSessionUsage();
    let running = zeroSessionUsage();

    const first = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({
        total_cost_usd: 14.22,
        num_turns: 6,
        duration_ms: 71_728,
        duration_api_ms: 1_250_927,
        modelUsage: mu({ "claude-opus-5": { in: 5270, out: 87_894, cost: 14.22 } }),
      }),
    );
    expect(first).not.toBeNull();
    ({ baseline, running } = first!);

    const second = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({
        total_cost_usd: 16.47,
        num_turns: 19,
        duration_ms: 127_857,
        duration_api_ms: 1_368_269,
        modelUsage: mu({ "claude-opus-5": { in: 5806, out: 95_575, cost: 16.47 } }),
      }),
    );
    expect(second).not.toBeNull();
    ({ baseline, running } = second!);

    const totals = addSessionUsage(baseline, running);
    // The old client-side additive fold would have reported ~$30.69 here.
    expect(totals.totalCostUsd).toBeCloseTo(16.47, 6);
    expect(totals.numTurns).toBe(19);
    expect(totals.durationMs).toBe(127_857);
    expect(totals.outputTokens).toBe(95_575);
  });

  test("a /clear-style reset (decreasing counters) banks the old running block", () => {
    let baseline = zeroSessionUsage();
    let running = zeroSessionUsage();
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 2.5, num_turns: 10, duration_ms: 60_000 }),
    )!);
    // Post-clear: running totals restart small.
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 0.3, num_turns: 2, duration_ms: 5_000 }),
    )!);
    const totals = addSessionUsage(baseline, running);
    expect(totals.totalCostUsd).toBeCloseTo(2.8, 6);
    expect(totals.numTurns).toBe(12);
    expect(totals.durationMs).toBe(65_000);
  });

  test("zeroed crash frame is ignored, not read as a reset (would double-count)", () => {
    let baseline = zeroSessionUsage();
    let running = zeroSessionUsage();
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 5, num_turns: 4, duration_ms: 30_000 }),
    )!);
    // SDK docs: crash/startup-error results "may carry zeroed values".
    const crash = foldResultIntoSessionUsage(baseline, running, resultMsg({}));
    expect(crash).toBeNull();
    // Next real result continues the SAME running block — totals must not
    // have banked the pre-crash block on the zero frame.
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 6, num_turns: 5, duration_ms: 40_000 }),
    )!);
    const totals = addSessionUsage(baseline, running);
    expect(totals.totalCostUsd).toBeCloseTo(6, 6);
    expect(totals.numTurns).toBe(5);
  });

  test("tokens come from cumulative modelUsage sums across models", () => {
    const { baseline, running } = foldResultIntoSessionUsage(
      zeroSessionUsage(),
      zeroSessionUsage(),
      resultMsg({
        total_cost_usd: 1,
        num_turns: 1,
        modelUsage: mu({
          "claude-opus-5": { in: 100, out: 200, cr: 1000, cc: 50 },
          "claude-haiku-4-5": { in: 10, out: 20, cr: 0, cc: 0 },
        }),
      }),
    )!;
    const totals = addSessionUsage(baseline, running);
    expect(totals.inputTokens).toBe(110);
    expect(totals.outputTokens).toBe(220);
    expect(totals.cacheReadInputTokens).toBe(1000);
    expect(totals.cacheCreationInputTokens).toBe(50);
  });

  test("without modelUsage, per-turn main-loop usage accumulates additively", () => {
    let baseline = zeroSessionUsage();
    let running = zeroSessionUsage();
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 0.1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } }),
    )!);
    ({ baseline, running } = foldResultIntoSessionUsage(
      baseline,
      running,
      resultMsg({ total_cost_usd: 0.2, num_turns: 2, usage: { input_tokens: 5, output_tokens: 7 } }),
    )!);
    const totals = addSessionUsage(baseline, running);
    expect(totals.inputTokens).toBe(15);
    expect(totals.outputTokens).toBe(27);
  });
});

describe("mergeModelUsage / addSessionUsage", () => {
  test("adds counter fields per model, latest wins for descriptive fields", () => {
    const merged = mergeModelUsage(
      mu({ "claude-opus-5": { in: 100, out: 200, cost: 1.5 } }),
      mu({ "claude-opus-5": { in: 10, out: 20, cost: 0.5 }, "claude-haiku-4-5": { in: 1, out: 2 } }),
    ) as Record<string, Record<string, unknown>>;
    expect(merged["claude-opus-5"].inputTokens).toBe(110);
    expect(merged["claude-opus-5"].costUSD).toBe(2);
    expect(merged["claude-opus-5"].contextWindow).toBe(200000); // latest, not summed
    expect(merged["claude-haiku-4-5"].inputTokens).toBe(1);
  });

  test("addSessionUsage sums scalars and carries merged modelUsage", () => {
    const a: SessionUsageTotals = {
      ...zeroSessionUsage(),
      totalCostUsd: 1,
      numTurns: 2,
      inputTokens: 10,
      modelUsage: mu({ m: { in: 10, cost: 1 } }),
    };
    const b: SessionUsageTotals = {
      ...zeroSessionUsage(),
      totalCostUsd: 0.5,
      numTurns: 3,
      inputTokens: 5,
      modelUsage: mu({ m: { in: 5, cost: 0.5 } }),
    };
    const sum = addSessionUsage(a, b);
    expect(sum.totalCostUsd).toBeCloseTo(1.5, 9);
    expect(sum.numTurns).toBe(5);
    expect(sum.inputTokens).toBe(15);
    expect((sum.modelUsage as Record<string, Record<string, unknown>>).m.inputTokens).toBe(15);
  });
});
