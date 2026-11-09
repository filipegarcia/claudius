import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { SessionLoop } from "@/lib/shared/session-loops";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SDK 0.3.321 — `CronDeleteOutput.endedLoopWakeup`. When the agent deletes the
 * session's self-paced wake-up via `CronDelete`, the result says so; the
 * server loop reducer must flip the pending wake-up (keyed by its
 * `ScheduleWakeup` tool_use id) to `cancelled`.
 */

const CWD = "/tmp/fake-cron-delete-ended-wakeup-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type SessionInternals = {
  trackScheduledLoops: (message: SDKMessage, at?: number) => void;
  getScheduledLoops: () => SessionLoop[];
};

function makeSession(): SessionInternals {
  return new Session({ id: "cron-delete-wakeup-test", cwd: CWD }) as unknown as SessionInternals;
}

const wakeup = (id: string): SDKMessage =>
  ({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "ScheduleWakeup", input: { delaySeconds: 600, prompt: "tick" } }],
    },
  }) as unknown as SDKMessage;

const cronDelete = (id: string): SDKMessage =>
  ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "CronDelete", input: { id: "wakeup-id" } }] },
  }) as unknown as SDKMessage;

const deleteResult = (toolUseId: string, toolUseResult: unknown): SDKMessage =>
  ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Cancelled job" }] },
    tool_use_result: toolUseResult,
  }) as unknown as SDKMessage;

describe("Session.trackScheduledLoops — CronDelete endedLoopWakeup", () => {
  test("endedLoopWakeup: true cancels the pending wake-up", () => {
    const s = makeSession();
    s.trackScheduledLoops(wakeup("toolu-w1"), 1000);
    s.trackScheduledLoops(cronDelete("toolu-del"), 2000);
    // The tool_use alone can't tell — the id doesn't match the rail key.
    expect(s.getScheduledLoops().find((l) => l.id === "toolu-w1")).toMatchObject({ cancelled: false });
    s.trackScheduledLoops(deleteResult("toolu-del", { id: "wakeup-id", endedLoopWakeup: true }), 2100);
    expect(s.getScheduledLoops().find((l) => l.id === "toolu-w1")).toMatchObject({ cancelled: true });
  });

  test("a plain cron delete result leaves the wake-up live", () => {
    const s = makeSession();
    s.trackScheduledLoops(wakeup("toolu-w1"), 1000);
    s.trackScheduledLoops(cronDelete("toolu-del"), 2000);
    s.trackScheduledLoops(deleteResult("toolu-del", { id: "some-cron" }), 2100);
    expect(s.getScheduledLoops().find((l) => l.id === "toolu-w1")).toMatchObject({ cancelled: false });
  });

  test("a replayed result does not cancel a newer wake-up", () => {
    const s = makeSession();
    s.trackScheduledLoops(wakeup("toolu-w1"), 1000);
    s.trackScheduledLoops(cronDelete("toolu-del"), 2000);
    s.trackScheduledLoops(deleteResult("toolu-del", { endedLoopWakeup: true }), 2100);
    s.trackScheduledLoops(wakeup("toolu-w2"), 3000);
    s.trackScheduledLoops(cronDelete("toolu-del"), 2000);
    s.trackScheduledLoops(deleteResult("toolu-del", { endedLoopWakeup: true }), 2100);
    expect(s.getScheduledLoops().find((l) => l.id === "toolu-w2")).toMatchObject({ cancelled: false });
  });
});
