import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { encodeProjectDir } from "@/lib/server/auto-memory";
import { aggregate, estimateSessionUsageFromTranscripts } from "@/lib/server/cost-aggregate";
import {
  __resetPricingMemo,
  costFromUsage,
  getPricingTable,
  priceForModel,
} from "@/lib/server/litellm-pricing";
import { lastRecordedCostState } from "@/lib/server/sdk-cost-state";

/**
 * Transcript-side inputs to session cost accounting:
 *
 * - `lastRecordedCostState` — the `cost-state` checkpoint a resumed CLI
 *   restores (and re-reports in its first result), so the live fold can avoid
 *   counting it twice.
 * - subagent / workflow-agent transcripts under `<id>/subagents/` — real
 *   spend that never appears in `<id>.jsonl`; a subagent-heavy session was
 *   under-reported by more than half on the Cost page without them.
 */

const SID = "aaaaaaaa-0000-0000-0000-00000000000a";

let cwd: string;
let projDir: string;

beforeEach(async () => {
  process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
  __resetPricingMemo();
  cwd = join(tmpdir(), `claudius-usage-test-${Math.random().toString(36).slice(2)}`);
  projDir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
  await fs.mkdir(projDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projDir, { recursive: true, force: true });
});

function assistant(msgId: string, opts: { output?: number; ts?: string; sidechain?: boolean } = {}): string {
  return JSON.stringify({
    type: "assistant",
    requestId: `req_${msgId}`,
    timestamp: opts.ts ?? "2026-10-26T10:00:00.000Z",
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: {
      id: msgId,
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        output_tokens: opts.output ?? 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function costState(sessionId: string, cost: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "cost-state",
    sessionId,
    totalCostUSD: cost,
    totalAPIDuration: cost * 1000,
    totalAPIDurationWithoutRetries: cost * 1000,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 0,
    startTime: 1,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 1,
        outputTokens: 2,
        thinkingTokens: 1,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
        webSearchRequests: 0,
        costUSD: cost,
      },
    },
    hasUnknownModelCost: false,
    ...extra,
  });
}

async function write(rel: string, lines: string[]): Promise<void> {
  const path = join(projDir, rel);
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, lines.join("\n") + "\n");
}

describe("lastRecordedCostState", () => {
  test("returns the LAST valid checkpoint for the session (last-wins, like the CLI)", async () => {
    await write(`${SID}.jsonl`, [
      assistant("m1"),
      costState(SID, 0),
      assistant("m2"),
      costState(SID, 208.25),
      costState(SID, 363.52),
      // Invalid (the CLI's schema rejects it) — must not win.
      costState(SID, 999, { totalCostUSD: -1 }),
      // Another session's record in the same file — ignored.
      costState("bbbbbbbb-0000-0000-0000-00000000000b", 50),
      assistant("m3"),
    ]);
    const cp = await lastRecordedCostState(SID, cwd);
    expect(cp?.totalCostUsd).toBeCloseTo(363.52, 9);
    expect(cp?.durationApiMs).toBeCloseTo(363_520, 6);
    expect((cp?.modelUsage as Record<string, Record<string, unknown>>)["claude-opus-5-5"].costUSD).toBe(
      363.52,
    );
  });

  test("a $0 checkpoint written after a real one is what gets restored", async () => {
    await write(`${SID}.jsonl`, [costState(SID, 12), costState(SID, 0)]);
    expect((await lastRecordedCostState(SID, cwd))?.totalCostUsd).toBe(0);
  });

  test("null when the transcript has no checkpoint, or doesn't exist, or the id is unsafe", async () => {
    await write(`${SID}.jsonl`, [assistant("m1")]);
    expect(await lastRecordedCostState(SID, cwd)).toBeNull();
    expect(await lastRecordedCostState("cccccccc-0000-0000-0000-00000000000c", cwd)).toBeNull();
    expect(await lastRecordedCostState("../escape", cwd)).toBeNull();
  });
});

describe("subagent transcripts", () => {
  async function perCall(output: number): Promise<number> {
    const table = await getPricingTable();
    return costFromUsage(priceForModel("claude-opus-4-7", table), {
      input: 100,
      output,
      cacheRead: 0,
      cacheCreation: 0,
    });
  }

  async function writeSessionWithSubagents(): Promise<void> {
    // Main thread: 2 API calls, the first split across two content-block
    // records (same msg/req id → counted once).
    await write(`${SID}.jsonl`, [assistant("main1"), assistant("main1"), assistant("main2")]);
    // Task subagent: 2 calls.
    await write(`${SID}/subagents/agent-a1.jsonl`, [
      assistant("sub1", { sidechain: true }),
      assistant("sub2", { sidechain: true }),
    ]);
    // Workflow agent, nested deeper; its journal has no API calls.
    await write(`${SID}/subagents/workflows/wf_x/agent-w1.jsonl`, [
      assistant("wf1", { sidechain: true, output: 5000 }),
    ]);
    await write(`${SID}/subagents/workflows/wf_x/journal.jsonl`, [JSON.stringify({ type: "phase" })]);
  }

  test("the Cost page attributes subagent and workflow-agent spend to the parent session", async () => {
    await writeSessionWithSubagents();
    const r = await aggregate(cwd);
    const expected = 4 * (await perCall(1000)) + (await perCall(5000));
    expect(r.bySession).toHaveLength(1);
    expect(r.bySession[0].sessionId).toBe(SID);
    expect(r.bySession[0].numTurns).toBe(5);
    expect(r.bySession[0].totalUsd).toBeCloseTo(expected, 10);
    expect(r.totalUsd).toBeCloseTo(expected, 10);
  });

  test("estimateSessionUsageFromTranscripts sums main + subagents; numTurns counts main-thread calls", async () => {
    await writeSessionWithSubagents();
    const est = await estimateSessionUsageFromTranscripts(cwd, SID);
    const expected = 4 * (await perCall(1000)) + (await perCall(5000));
    expect(est).not.toBeNull();
    expect(est!.totalCostUsd).toBeCloseTo(expected, 10);
    expect(est!.numTurns).toBe(2);
    expect(est!.inputTokens).toBe(500);
    expect(est!.outputTokens).toBe(9000);
    const m = (est!.modelUsage as Record<string, Record<string, number>>)["claude-opus-4-7"];
    expect(m.outputTokens).toBe(9000);
    expect(m.costUSD).toBeCloseTo(expected, 10);
  });

  test("estimate is null for a session with no priced calls", async () => {
    await write(`${SID}.jsonl`, [JSON.stringify({ type: "user", message: { content: "hi" } })]);
    expect(await estimateSessionUsageFromTranscripts(cwd, SID)).toBeNull();
    expect(await estimateSessionUsageFromTranscripts(cwd, "../nope")).toBeNull();
  });
});
