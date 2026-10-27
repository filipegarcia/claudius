import { describe, expect, test } from "vitest";

import {
  foldResultIntoSessionUsage,
  mergeModelUsage,
  zeroSdkCumulativeUsage,
  zeroSessionUsage,
} from "@/lib/server/session";
import type { SdkCumulativeUsage } from "@/lib/server/sdk-cost-state";
import type { SessionUsageTotals } from "@/lib/shared/events";

/**
 * SDK `result` fields are of two kinds (read off the CLI's result builder):
 *
 * - PER-TURN: `num_turns` ("model round-trips within one turn") and
 *   `duration_ms` — summed across results.
 * - PROCESS-CUMULATIVE: `total_cost_usd`, `modelUsage`, `duration_api_ms` —
 *   only their growth since the previous result is new spend. A resumed CLI
 *   restores them from the transcript's last `cost-state` checkpoint, which
 *   the caller seeds as `last`.
 *
 * The pre-fix fold treated `num_turns` as cumulative, so every turn shorter
 * than the previous one looked like a `/clear` and re-banked the session's
 * whole running cost — a real 1.5-day session read $12,078 for ~$730 of spend.
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

/** Fold a sequence of result messages from a starting state. */
function foldAll(
  messages: Record<string, unknown>[],
  start: { totals?: SessionUsageTotals; last?: SdkCumulativeUsage } = {},
): SessionUsageTotals {
  let totals = start.totals ?? zeroSessionUsage();
  let last = start.last ?? zeroSdkCumulativeUsage();
  for (const m of messages) {
    const folded = foldResultIntoSessionUsage(totals, last, m);
    if (!folded) continue;
    ({ totals, last } = folded);
  }
  return totals;
}

describe("foldResultIntoSessionUsage", () => {
  test("cumulative cost/modelUsage count only their growth; per-turn num_turns/duration_ms are summed", () => {
    const totals = foldAll([
      resultMsg({
        total_cost_usd: 14.22,
        num_turns: 6,
        duration_ms: 71_728,
        duration_api_ms: 1_250_927,
        modelUsage: mu({ "claude-opus-5": { in: 5270, out: 87_894, cost: 14.22 } }),
      }),
      resultMsg({
        total_cost_usd: 16.47,
        num_turns: 19,
        duration_ms: 56_129,
        duration_api_ms: 1_368_269,
        modelUsage: mu({ "claude-opus-5": { in: 5806, out: 95_575, cost: 16.47 } }),
      }),
    ]);
    expect(totals.totalCostUsd).toBeCloseTo(16.47, 6);
    expect(totals.numTurns).toBe(25);
    expect(totals.durationMs).toBe(127_857);
    expect(totals.durationApiMs).toBe(1_368_269);
    expect(totals.inputTokens).toBe(5806);
    expect(totals.outputTokens).toBe(95_575);
    const opus = (totals.modelUsage as Record<string, Record<string, unknown>>)["claude-opus-5"];
    expect(opus.costUSD).toBeCloseTo(16.47, 6);
    expect(opus.outputTokens).toBe(95_575);
  });

  test("REGRESSION: a turn with fewer round-trips than the last is NOT a reset (no re-banking)", () => {
    // Long turn, then two short ones — the shape that inflated real sessions.
    const totals = foldAll([
      resultMsg({ total_cost_usd: 10, num_turns: 40, modelUsage: mu({ m: { out: 1000, cost: 10 } }) }),
      resultMsg({ total_cost_usd: 11, num_turns: 3, modelUsage: mu({ m: { out: 1100, cost: 11 } }) }),
      resultMsg({ total_cost_usd: 12, num_turns: 1, modelUsage: mu({ m: { out: 1200, cost: 12 } }) }),
    ]);
    // Old fold: 10 + 11 + 12 = 33.
    expect(totals.totalCostUsd).toBeCloseTo(12, 6);
    expect(totals.outputTokens).toBe(1200);
    expect(totals.numTurns).toBe(44);
  });

  test("a /clear (cumulative cost decreases) counts the new block from zero, keeping the old", () => {
    const totals = foldAll([
      resultMsg({ total_cost_usd: 2.5, num_turns: 10, duration_ms: 60_000, duration_api_ms: 40_000 }),
      resultMsg({ total_cost_usd: 0.3, num_turns: 2, duration_ms: 5_000, duration_api_ms: 3_000 }),
    ]);
    expect(totals.totalCostUsd).toBeCloseTo(2.8, 6);
    expect(totals.numTurns).toBe(12);
    expect(totals.durationMs).toBe(65_000);
    expect(totals.durationApiMs).toBe(43_000);
  });

  test("zeroed crash frame is ignored, not read as a reset (would double-count)", () => {
    let totals = zeroSessionUsage();
    let last = zeroSdkCumulativeUsage();
    ({ totals, last } = foldResultIntoSessionUsage(
      totals,
      last,
      resultMsg({ total_cost_usd: 5, num_turns: 4, duration_ms: 30_000 }),
    )!);
    // SDK docs: crash/startup-error results "may carry zeroed values".
    expect(foldResultIntoSessionUsage(totals, last, resultMsg({}))).toBeNull();
    ({ totals, last } = foldResultIntoSessionUsage(
      totals,
      last,
      resultMsg({ total_cost_usd: 6, num_turns: 1, duration_ms: 10_000 }),
    )!);
    expect(totals.totalCostUsd).toBeCloseTo(6, 6);
    expect(totals.numTurns).toBe(5);
  });

  test("SDK 0.3.274: an empty queued-completion frame with nonzero duration is ignored", () => {
    let totals = zeroSessionUsage();
    let last = zeroSdkCumulativeUsage();
    ({ totals, last } = foldResultIntoSessionUsage(
      totals,
      last,
      resultMsg({ total_cost_usd: 5, num_turns: 4, duration_ms: 30_000 }),
    )!);
    expect(foldResultIntoSessionUsage(totals, last, resultMsg({ duration_ms: 1_200 }))).toBeNull();
    ({ totals, last } = foldResultIntoSessionUsage(
      totals,
      last,
      resultMsg({ total_cost_usd: 6, num_turns: 1, duration_ms: 10_000 }),
    )!);
    expect(totals.totalCostUsd).toBeCloseTo(6, 6);
    expect(totals.numTurns).toBe(5);
    expect(totals.durationMs).toBe(40_000);
  });

  test("token deltas are per model — a model that didn't grow adds nothing", () => {
    const totals = foldAll([
      resultMsg({
        total_cost_usd: 1,
        num_turns: 1,
        modelUsage: mu({
          "claude-opus-5": { in: 100, out: 200, cr: 1000, cc: 50, cost: 0.9 },
          "claude-haiku-4-5": { in: 10, out: 20, cost: 0.1 },
        }),
      }),
      resultMsg({
        total_cost_usd: 1.5,
        num_turns: 2,
        modelUsage: mu({
          "claude-opus-5": { in: 150, out: 300, cr: 3000, cc: 50, cost: 1.4 },
          "claude-haiku-4-5": { in: 10, out: 20, cost: 0.1 },
        }),
      }),
    ]);
    expect(totals.inputTokens).toBe(160);
    expect(totals.outputTokens).toBe(320);
    expect(totals.cacheReadInputTokens).toBe(3000);
    expect(totals.cacheCreationInputTokens).toBe(50);
    const byModel = totals.modelUsage as Record<string, Record<string, unknown>>;
    expect(byModel["claude-opus-5"].costUSD).toBeCloseTo(1.4, 9);
    expect(byModel["claude-haiku-4-5"].inputTokens).toBe(10);
  });

  test("without modelUsage, per-turn main-loop usage accumulates additively", () => {
    const totals = foldAll([
      resultMsg({ total_cost_usd: 0.1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 20 } }),
      resultMsg({ total_cost_usd: 0.2, num_turns: 2, usage: { input_tokens: 5, output_tokens: 7 } }),
    ]);
    expect(totals.totalCostUsd).toBeCloseTo(0.2, 9);
    expect(totals.inputTokens).toBe(15);
    expect(totals.outputTokens).toBe(27);
  });
});

describe("resume: seeded checkpoint vs persisted totals", () => {
  // Persisted totals ($7) are ahead of the transcript checkpoint ($5): the
  // previous CLI kept spending after its last graceful exit and was then
  // killed, so it never wrote a newer `cost-state`.
  const persisted: SessionUsageTotals = {
    ...zeroSessionUsage(),
    totalCostUsd: 7,
    numTurns: 30,
    outputTokens: 7000,
    modelUsage: mu({ "claude-opus-5": { out: 7000, cost: 7 } }),
  };
  const checkpoint: SdkCumulativeUsage = {
    totalCostUsd: 5,
    durationApiMs: 90_000,
    modelUsage: mu({ "claude-opus-5": { out: 5000, cost: 5 } }),
  };

  test("the restored checkpoint isn't counted again — only this process's spend is added", () => {
    const totals = foldAll(
      [
        resultMsg({
          total_cost_usd: 5.5,
          num_turns: 2,
          duration_api_ms: 95_000,
          modelUsage: mu({ "claude-opus-5": { out: 5500, cost: 5.5 } }),
        }),
      ],
      { totals: persisted, last: checkpoint },
    );
    expect(totals.totalCostUsd).toBeCloseTo(7.5, 6);
    expect(totals.outputTokens).toBe(7500);
    expect(totals.numTurns).toBe(32);
    expect(totals.durationApiMs).toBe(5_000);
    expect(
      (totals.modelUsage as Record<string, Record<string, unknown>>)["claude-opus-5"].costUSD,
    ).toBeCloseTo(7.5, 9);
  });

  test("a CLI that did NOT restore the checkpoint (first result below it) counts from zero", () => {
    const totals = foldAll(
      [resultMsg({ total_cost_usd: 0.4, num_turns: 1, modelUsage: mu({ "claude-opus-5": { out: 400, cost: 0.4 } }) })],
      { totals: persisted, last: checkpoint },
    );
    expect(totals.totalCostUsd).toBeCloseTo(7.4, 6);
    expect(totals.outputTokens).toBe(7400);
  });

  test("a $0 checkpoint left by a side process means the whole first result is new", () => {
    const totals = foldAll(
      [resultMsg({ total_cost_usd: 0.8, num_turns: 3, modelUsage: mu({ "claude-opus-5": { out: 800, cost: 0.8 } }) })],
      { totals: persisted, last: { totalCostUsd: 0, durationApiMs: 0 } },
    );
    expect(totals.totalCostUsd).toBeCloseTo(7.8, 6);
  });
});

describe("mergeModelUsage", () => {
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

  // SDK 0.3.257 — `thinkingTokens` is a subset already counted inside
  // `outputTokens`. It must accumulate the same way outputTokens does,
  // not last-write-wins like a descriptive field (contextWindow).
  test("accumulates thinkingTokens (SDK 0.3.257)", () => {
    const merged = mergeModelUsage(
      { "claude-opus-5": { outputTokens: 200, thinkingTokens: 50 } },
      { "claude-opus-5": { outputTokens: 20, thinkingTokens: 5 } },
    ) as Record<string, Record<string, unknown>>;
    expect(merged["claude-opus-5"].outputTokens).toBe(220);
    expect(merged["claude-opus-5"].thinkingTokens).toBe(55);
  });

  test("thinkingTokens absent on one side is just carried, not treated as 0", () => {
    const merged = mergeModelUsage(
      { "claude-opus-5": { outputTokens: 200 } },
      { "claude-opus-5": { outputTokens: 20, thinkingTokens: 5 } },
    ) as Record<string, Record<string, unknown>>;
    expect(merged["claude-opus-5"].thinkingTokens).toBe(5);
  });

  // SDK 0.3.311 — the 5m/1h split of cacheCreationInputTokens accumulates
  // across SDK-process merges; absent on one side is carried, not zeroed.
  test("accumulates cache-creation 5m/1h split across merges (SDK 0.3.311)", () => {
    const merged = mergeModelUsage(
      {
        "claude-opus-5": {
          cacheCreationInputTokens: 300,
          cacheCreationEphemeral5mInputTokens: 100,
          cacheCreationEphemeral1hInputTokens: 200,
        },
      },
      {
        "claude-opus-5": {
          cacheCreationInputTokens: 30,
          cacheCreationEphemeral5mInputTokens: 10,
          cacheCreationEphemeral1hInputTokens: 20,
        },
      },
    ) as Record<string, Record<string, unknown>>;
    expect(merged["claude-opus-5"].cacheCreationEphemeral5mInputTokens).toBe(110);
    expect(merged["claude-opus-5"].cacheCreationEphemeral1hInputTokens).toBe(220);
    const carried = mergeModelUsage(
      { "claude-opus-5": { cacheCreationInputTokens: 300 } },
      { "claude-opus-5": { cacheCreationInputTokens: 30, cacheCreationEphemeral1hInputTokens: 20 } },
    ) as Record<string, Record<string, unknown>>;
    expect(carried["claude-opus-5"].cacheCreationEphemeral1hInputTokens).toBe(20);
  });

  test("the fold's per-model deltas cover the 5m/1h split too (SDK 0.3.311)", () => {
    const split = (cc: number, m5: number, h1: number, cost: number) => ({
      m: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: cc,
        cacheCreationEphemeral5mInputTokens: m5,
        cacheCreationEphemeral1hInputTokens: h1,
        webSearchRequests: 0,
        costUSD: cost,
      },
    });
    const totals = foldAll([
      resultMsg({ total_cost_usd: 1, num_turns: 1, modelUsage: split(300, 100, 200, 1) }),
      resultMsg({ total_cost_usd: 1.2, num_turns: 1, modelUsage: split(330, 110, 220, 1.2) }),
    ]);
    const m = (totals.modelUsage as Record<string, Record<string, unknown>>).m;
    expect(m.cacheCreationEphemeral5mInputTokens).toBe(110);
    expect(m.cacheCreationEphemeral1hInputTokens).toBe(220);
    expect(totals.cacheCreationInputTokens).toBe(330);
  });
});
