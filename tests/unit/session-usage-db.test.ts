import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getSessionUsage, saveSessionUsage } from "@/lib/server/session-usage-db";
import { openDb } from "@/lib/server/db";
import type { SessionUsageTotals } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for the durable per-session cost/usage accumulator
 * (migration 019). This row is what stops the /cost dialog from resetting
 * whenever a session is rebuilt from disk — SDK `result` frames never reach
 * the JSONL, so without it there is no durable cost record at all. Each test
 * gets a fresh tmp HOME so the migration runs from scratch.
 */

const CWD = "/tmp/fake-session-usage-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

const TOTALS: SessionUsageTotals = {
  totalCostUsd: 1.23,
  numTurns: 4,
  durationMs: 1_000,
  durationApiMs: 2_000,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadInputTokens: 30,
  cacheCreationInputTokens: 40,
  modelUsage: { "claude-opus-5": { inputTokens: 10, costUSD: 1.23 } },
};

describe("session-usage-db roundtrip", () => {
  test("save → get returns the same totals, including the model breakdown", async () => {
    await saveSessionUsage(CWD, "sess-a", TOTALS);
    expect(await getSessionUsage(CWD, "sess-a")).toEqual(TOTALS);
  });

  test("missing row returns null", async () => {
    expect(await getSessionUsage(CWD, "nope")).toBeNull();
  });

  test("second save upserts (replaces, not accumulates) — the caller owns the math", async () => {
    await saveSessionUsage(CWD, "sess-a", TOTALS);
    const next: SessionUsageTotals = {
      ...TOTALS,
      totalCostUsd: 2.46,
      numTurns: 8,
      modelUsage: undefined,
    };
    await saveSessionUsage(CWD, "sess-a", next);
    const got = await getSessionUsage(CWD, "sess-a");
    expect(got?.totalCostUsd).toBe(2.46);
    expect(got?.numTurns).toBe(8);
    // modelUsage omitted on the second save → cleared, not carried over.
    expect(got?.modelUsage).toBeUndefined();
  });

  test("rows are keyed per session id", async () => {
    await saveSessionUsage(CWD, "sess-a", TOTALS);
    await saveSessionUsage(CWD, "sess-b", { ...TOTALS, totalCostUsd: 9 });
    expect((await getSessionUsage(CWD, "sess-a"))?.totalCostUsd).toBe(1.23);
    expect((await getSessionUsage(CWD, "sess-b"))?.totalCostUsd).toBe(9);
  });
});
