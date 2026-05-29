import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { aggregate } from "@/lib/server/cost-aggregate";
import {
  __resetPricingMemo,
  costFromUsage,
  getPricingTable,
  priceForModel,
  type LiteLlmPricing,
} from "@/lib/server/litellm-pricing";

/**
 * Cost aggregation must match ccusage's methodology: price on-disk token counts
 * with LiteLLM list prices and dedup by message+request id so resumed/forked
 * sessions (which replay prior turns verbatim) aren't double-counted. These
 * specs pin both the pure pricer and the cross-file dedup.
 *
 * Network pricing refresh is disabled so the bundled snapshot is the only
 * source — deterministic in CI.
 */

describe("litellm pricer", () => {
  test("costFromUsage applies per-token rates", () => {
    const p: LiteLlmPricing = {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
      cache_read_input_token_cost: 0.5e-6,
      cache_creation_input_token_cost: 6.25e-6,
    };
    const usd = costFromUsage(p, { input: 1000, output: 1000, cacheRead: 1000, cacheCreation: 1000 });
    expect(usd).toBeCloseTo((5 + 25 + 0.5 + 6.25) / 1000, 10);
  });

  test("costFromUsage uses the >200k tier only past the threshold", () => {
    const p: LiteLlmPricing = {
      input_cost_per_token: 3e-6,
      input_cost_per_token_above_200k_tokens: 6e-6,
    };
    const small = costFromUsage(p, { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 });
    const big = costFromUsage(p, { input: 300_000, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(small).toBeCloseTo(100 * 3e-6, 12);
    expect(big).toBeCloseTo(300_000 * 6e-6, 9);
  });

  test("unpriced model contributes nothing", () => {
    expect(costFromUsage(undefined, { input: 9e9, output: 9e9, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });

  test("priceForModel resolves exact, provider-prefixed, family, and unknown", async () => {
    __resetPricingMemo();
    const table = await getPricingTable();
    expect(priceForModel("claude-opus-4-7", table)).toBeDefined();
    // provider-prefixed id strips down to the bare model
    expect(priceForModel("anthropic/claude-opus-4-7", table)).toEqual(
      priceForModel("claude-opus-4-7", table),
    );
    // unknown future opus still resolves to *some* opus pricing via family fallback
    expect(priceForModel("claude-opus-99-9", table)).toBeDefined();
    expect(priceForModel("totally-made-up-model", table)).toBeUndefined();
  });
});

describe("aggregate dedup", () => {
  let cwd: string;
  let projDir: string;

  beforeEach(async () => {
    process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
    __resetPricingMemo();
    cwd = join(tmpdir(), `claudius-cost-test-${Math.random().toString(36).slice(2)}`);
    projDir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
    await fs.mkdir(projDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projDir, { recursive: true, force: true });
  });

  function assistant(opts: {
    msgId: string;
    reqId: string;
    ts: string;
    model?: string;
    input?: number;
    output?: number;
    costUSD?: number;
  }): string {
    return JSON.stringify({
      type: "assistant",
      requestId: opts.reqId,
      timestamp: opts.ts,
      ...(opts.costUSD != null ? { costUSD: opts.costUSD } : {}),
      message: {
        id: opts.msgId,
        model: opts.model ?? "claude-opus-4-7",
        usage: {
          input_tokens: opts.input ?? 1000,
          output_tokens: opts.output ?? 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  test("counts a turn replayed across resumed sessions exactly once", async () => {
    // Session A: turns A1, A2 on day 1.
    await fs.writeFile(
      join(projDir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl"),
      [
        assistant({ msgId: "msg_a1", reqId: "req_a1", ts: "2026-05-01T10:00:00.000Z" }),
        assistant({ msgId: "msg_a2", reqId: "req_a2", ts: "2026-05-01T10:05:00.000Z" }),
      ].join("\n") + "\n",
    );
    // Session B resumes A: it REPLAYS A2 (same msg/req id) then adds B1.
    await fs.writeFile(
      join(projDir, "bbbbbbbb-0000-0000-0000-000000000002.jsonl"),
      [
        assistant({ msgId: "msg_a2", reqId: "req_a2", ts: "2026-05-01T10:05:00.000Z" }),
        assistant({ msgId: "msg_b1", reqId: "req_b1", ts: "2026-05-02T09:00:00.000Z" }),
      ].join("\n") + "\n",
    );

    const table = await getPricingTable();
    const per = costFromUsage(priceForModel("claude-opus-4-7", table), {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheCreation: 0,
    });

    const r = await aggregate(cwd);

    // 3 unique turns (A1, A2, B1) — not 4.
    expect(r.totalUsd).toBeCloseTo(per * 3, 10);

    const a = r.bySession.find((s) => s.sessionId.startsWith("aaaaaaaa"))!;
    const b = r.bySession.find((s) => s.sessionId.startsWith("bbbbbbbb"))!;
    // A is older → keeps the shared turn; B only gets its net-new turn.
    expect(a.numTurns).toBe(2);
    expect(b.numTurns).toBe(1);
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0].model).toBe("claude-opus-4-7");
  });

  test("skips <synthetic> turns and honors costUSD overrides", async () => {
    await fs.writeFile(
      join(projDir, "cccccccc-0000-0000-0000-000000000003.jsonl"),
      [
        assistant({ msgId: "msg_s", reqId: "req_s", ts: "2026-05-03T10:00:00.000Z", model: "<synthetic>" }),
        assistant({ msgId: "msg_c1", reqId: "req_c1", ts: "2026-05-03T10:01:00.000Z", costUSD: 0.123 }),
      ].join("\n") + "\n",
    );

    const r = await aggregate(cwd);
    expect(r.totalUsd).toBeCloseTo(0.123, 10); // synthetic dropped, costUSD trusted
    expect(r.bySession[0].numTurns).toBe(1);
  });
});
