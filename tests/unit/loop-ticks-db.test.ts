import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  attachLoopTickTokens,
  listLoopBreakdown,
  recordLoopTick,
} from "@/lib/server/loop-ticks-db";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for the Loops breakdown (Claude Code 2.1.243
 * parity — "Added a Loops breakdown to /usage"). Claudius's live
 * `Session.scheduledLoops` map only ever holds the *current* tick (each new
 * `ScheduleWakeup` supersedes the last — see `trackScheduledLoops` in
 * session.ts), so this table is the only history. Each test gets a fresh
 * tmp HOME so migration 017 runs from scratch.
 */

const CWD = "/tmp/fake-loop-ticks-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

describe("loop-ticks-db roundtrip", () => {
  test("aggregates run count, total tokens, tokens/run, last run — grouped by session", async () => {
    await recordLoopTick(CWD, {
      sessionId: "sess-a",
      sessionTitle: "Refactor sweep",
      toolUseId: "toolu-1",
      prompt: "check the build",
      firedAt: 1000,
      noop: true,
    });
    await attachLoopTickTokens(CWD, "toolu-1", 500);

    await recordLoopTick(CWD, {
      sessionId: "sess-a",
      sessionTitle: "Refactor sweep",
      toolUseId: "toolu-2",
      prompt: "check the build",
      firedAt: 2000,
      noop: false,
    });
    await attachLoopTickTokens(CWD, "toolu-2", 1500);

    // A second, unrelated session — proves grouping doesn't cross session
    // boundaries.
    await recordLoopTick(CWD, {
      sessionId: "sess-b",
      sessionTitle: null,
      toolUseId: "toolu-3",
      prompt: "watch CI",
      firedAt: 1500,
      noop: false,
    });

    const rows = await listLoopBreakdown(CWD);
    expect(rows).toHaveLength(2);

    // Newest last-run first.
    expect(rows[0].sessionId).toBe("sess-a");
    expect(rows[0].runCount).toBe(2);
    expect(rows[0].totalTokens).toBe(2000);
    expect(rows[0].tokensPerRun).toBe(1000);
    expect(rows[0].lastRun).toBe(2000);
    expect(rows[0].lastPrompt).toBe("check the build");
    expect(rows[0].sessionTitle).toBe("Refactor sweep");

    expect(rows[1].sessionId).toBe("sess-b");
    expect(rows[1].runCount).toBe(1);
    // Never attached — sums to 0, not null/NaN.
    expect(rows[1].totalTokens).toBe(0);
    expect(rows[1].tokensPerRun).toBe(0);
  });

  test("recordLoopTick is idempotent on the same tool_use_id", async () => {
    await recordLoopTick(CWD, {
      sessionId: "sess-a",
      sessionTitle: null,
      toolUseId: "toolu-1",
      prompt: "p",
      firedAt: 1000,
      noop: false,
    });
    // A replay of the same message (e.g. disk resync) shouldn't double-count.
    await recordLoopTick(CWD, {
      sessionId: "sess-a",
      sessionTitle: null,
      toolUseId: "toolu-1",
      prompt: "p",
      firedAt: 1000,
      noop: false,
    });

    const rows = await listLoopBreakdown(CWD);
    expect(rows).toHaveLength(1);
    expect(rows[0].runCount).toBe(1);
  });

  test("attachLoopTickTokens is a no-op for an unknown tool_use_id", async () => {
    await expect(attachLoopTickTokens(CWD, "does-not-exist", 100)).resolves.toBeUndefined();
    expect(await listLoopBreakdown(CWD)).toEqual([]);
  });
});

describe("Session.trackScheduledLoops loop-tick wiring", () => {
  /** Reach into the private hook the same way session-tasks.test.ts does. */
  type SessionInternals = {
    trackScheduledLoops: (message: SDKMessage, at?: number) => void;
  };

  function makeSession(): SessionInternals {
    return new Session({ id: "loops-test", cwd: CWD }) as unknown as SessionInternals;
  }

  function wakeupToolUse(id: string, prompt: string, noop = false): SDKMessage {
    return {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "ScheduleWakeup",
            input: { delaySeconds: 60, prompt, noop },
          },
        ],
      },
    } as unknown as SDKMessage;
  }

  function resultMessage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }): SDKMessage {
    return { type: "result", subtype: "success", usage } as unknown as SDKMessage;
  }

  test("records a tick on ScheduleWakeup and attaches the next result's usage", async () => {
    const session = makeSession();
    session.trackScheduledLoops(wakeupToolUse("toolu-live-1", "keep checking", false), 5000);
    session.trackScheduledLoops(
      resultMessage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }),
    );

    // recordLoopTick/attachLoopTickTokens are fire-and-forget (`void`) —
    // poll briefly the same way waitForTask does in session-tasks.test.ts.
    let rows = await listLoopBreakdown(CWD);
    for (let i = 0; i < 50 && (rows.length === 0 || rows[0].totalTokens === 0); i++) {
      await new Promise((r) => setTimeout(r, 5));
      rows = await listLoopBreakdown(CWD);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("loops-test");
    expect(rows[0].runCount).toBe(1);
    expect(rows[0].totalTokens).toBe(160);
    expect(rows[0].lastRun).toBe(5000);
  });
});
