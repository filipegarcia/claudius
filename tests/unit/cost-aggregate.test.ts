import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { aggregate } from "@/lib/server/cost-aggregate";
import {
  __resetPricingMemo,
  costFromUsage,
  getPricingStatus,
  getPricingTable,
  priceForModel,
  refreshPricing,
  type LiteLlmPricing,
} from "@/lib/server/litellm-pricing";
import { openDb } from "@/lib/server/db";
import { setSessionTitle } from "@/lib/server/sessions-db";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

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

  // CC 2.1.300 — mirrors the engine's split pricer: the 1h slice of cache
  // writes bills at 2x input, the rest at the 5m (1.25x) cache-write rate.
  describe("1h cache writes", () => {
    const OPUS: LiteLlmPricing = {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
      cache_read_input_token_cost: 0.5e-6,
      cache_creation_input_token_cost: 6.25e-6,
    };
    const writes = (total: number, oneHour?: number) => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: total,
      ...(oneHour != null ? { cacheCreation1h: oneHour } : {}),
    });

    test("a 1h-only write prices at 2x input ($10/MTok), not the 5m rate", () => {
      expect(costFromUsage(OPUS, writes(100_000, 100_000))).toBeCloseTo(1.0, 10);
    });

    test("a mixed 5m/1h write splits across both rates", () => {
      // 60k × $10/MTok + 40k × $6.25/MTok
      expect(costFromUsage(OPUS, writes(100_000, 60_000))).toBeCloseTo(0.6 + 0.25, 10);
    });

    test("a 5m-only write is unchanged", () => {
      expect(costFromUsage(OPUS, writes(100_000))).toBeCloseTo(0.625, 10);
      expect(costFromUsage(OPUS, writes(100_000, 0))).toBeCloseTo(0.625, 10);
    });

    test("the 1h slice is clamped to the total cache-write count", () => {
      expect(costFromUsage(OPUS, writes(100_000, 500_000))).toBeCloseTo(1.0, 10);
    });

    test("long-context tiers double the tiered input rate", () => {
      const haiku55: LiteLlmPricing = {
        input_cost_per_token: 1e-7,
        cache_creation_input_token_cost: 1.25e-7,
        input_cost_per_token_above_100k_tokens: 5e-7,
        cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
      };
      // 150k 1h writes cross the 100k tier → 2 × $0.50/MTok = $1/MTok.
      expect(costFromUsage(haiku55, writes(150_000, 150_000))).toBeCloseTo(150_000 * 1e-6, 10);
    });
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

describe("price refresh", () => {
  test("refreshPricing reports a clear result when refresh is disabled", async () => {
    const prev = process.env.CLAUDIUS_DISABLE_PRICE_REFRESH;
    process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
    __resetPricingMemo();
    try {
      const r = await refreshPricing();
      expect(r.ok).toBe(false);
      expect(r.source).toBe("disabled");
      expect(r.models).toBeGreaterThan(0); // bundled snapshot is still usable
      expect(r.reason).toMatch(/disabled/i);
    } finally {
      if (prev === undefined) delete process.env.CLAUDIUS_DISABLE_PRICE_REFRESH;
      else process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = prev;
    }
  });

  test("getPricingStatus always reports a usable table", async () => {
    const s = await getPricingStatus();
    expect(["cache", "bundle"]).toContain(s.source);
    expect(s.models).toBeGreaterThan(0);
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
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  }): string {
    const cw5m = opts.cacheWrite5m ?? 0;
    const cw1h = opts.cacheWrite1h ?? 0;
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
          cache_creation_input_tokens: cw5m + cw1h,
          ...(cw5m || cw1h
            ? { cache_creation: { ephemeral_5m_input_tokens: cw5m, ephemeral_1h_input_tokens: cw1h } }
            : {}),
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

  test("prices 1h cache writes from the transcript at the 1h rate (CC 2.1.300)", async () => {
    const table = await getPricingTable();
    const p = priceForModel("claude-opus-4-7", table)!;
    const input = p.input_cost_per_token!;
    const write5m = p.cache_creation_input_token_cost!;
    const base = { ts: "2026-05-04T10:00:00.000Z", input: 0, output: 0 };
    await fs.writeFile(
      join(projDir, "dddddddd-0000-0000-0000-000000000004.jsonl"),
      [
        assistant({ ...base, msgId: "msg_1h", reqId: "req_1h", cacheWrite1h: 100_000 }),
        assistant({ ...base, msgId: "msg_mx", reqId: "req_mx", cacheWrite5m: 40_000, cacheWrite1h: 60_000 }),
        assistant({ ...base, msgId: "msg_5m", reqId: "req_5m", cacheWrite5m: 100_000 }),
      ].join("\n") + "\n",
    );

    const r = await aggregate(cwd);

    const expected =
      100_000 * 2 * input + // 1h-only
      (60_000 * 2 * input + 40_000 * write5m) + // mixed
      100_000 * write5m; // 5m-only, unchanged
    expect(r.totalUsd).toBeCloseTo(expected, 10);
    // claude-opus-4-7 lists at $5/MTok input: 100k 1h writes = $1.00, not $0.625.
    expect(100_000 * 2 * input).toBeCloseTo(1.0, 10);
  });
});

describe("aggregate session titles", () => {
  // Real temp $HOME so the per-project `.claudius.db` (where titles live) and
  // the `~/.claude/projects/<enc>` JSONL tree land in the same throwaway root
  // the title lookup + the cost reader both resolve via `homedir()`.
  let tmp: TmpHome;
  let cwd: string;
  let projDir: string;

  beforeEach(async () => {
    process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
    __resetPricingMemo();
    tmp = makeTempHome();
    cwd = join(tmpdir(), `claudius-cost-titles-${Math.random().toString(36).slice(2)}`);
    projDir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
    await fs.mkdir(projDir, { recursive: true });
    // Create the project's `.claudius.db` + run migrations so `setSessionTitle`
    // has a `sessions` table to write into.
    await openDb(cwd);
  });

  afterEach(() => {
    tmp.restore();
  });

  function turn(msgId: string, reqId: string): string {
    return JSON.stringify({
      type: "assistant",
      requestId: reqId,
      timestamp: "2026-05-20T10:00:00.000Z",
      message: {
        id: msgId,
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 100,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  test("attaches the user-assigned title from .claudius.db to its session", async () => {
    const titledId = "dddddddd-0000-0000-0000-000000000001";
    const untitledId = "eeeeeeee-0000-0000-0000-000000000002";
    await fs.writeFile(join(projDir, `${titledId}.jsonl`), turn("msg_d1", "req_d1") + "\n");
    await fs.writeFile(join(projDir, `${untitledId}.jsonl`), turn("msg_e1", "req_e1") + "\n");
    await setSessionTitle(cwd, titledId, "Refactor cost page");

    const r = await aggregate(cwd);

    const titled = r.bySession.find((s) => s.sessionId === titledId)!;
    const untitled = r.bySession.find((s) => s.sessionId === untitledId)!;
    expect(titled.title).toBe("Refactor cost page");
    // A session with no DB row stays undefined so the table falls back to the id.
    expect(untitled.title).toBeUndefined();
  });

  test("a title lookup failure never breaks the report (best-effort enrichment)", async () => {
    // No title written and no DB row for this id — the report still builds and
    // simply omits the title rather than throwing.
    const id = "ffffffff-0000-0000-0000-000000000003";
    await fs.writeFile(join(projDir, `${id}.jsonl`), turn("msg_f1", "req_f1") + "\n");

    const r = await aggregate(cwd);

    expect(r.bySession).toHaveLength(1);
    expect(r.bySession[0].sessionId).toBe(id);
    expect(r.bySession[0].title).toBeUndefined();
  });
});
