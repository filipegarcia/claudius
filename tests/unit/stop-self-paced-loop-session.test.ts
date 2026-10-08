import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listLoopBreakdown } from "@/lib/server/loop-ticks-db";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { SessionLoop } from "@/lib/shared/session-loops";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.295 parity — the server-side loop reducer (`trackScheduledLoops`)
 * must treat `ScheduleWakeup { stop: true }` as the end of a self-paced loop,
 * not a fresh arm: the pending wake-up stays listed as `cancelled` (what the
 * `/schedule` page renders), no ghost entry is created under the stop's
 * tool_use id, and no phantom tick lands in the Loops breakdown. Same private
 * hook access as `loop-ticks-db.test.ts`.
 */

const CWD = "/tmp/fake-stop-self-paced-loop-cwd";

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
  return new Session({ id: "stop-loop-test", cwd: CWD }) as unknown as SessionInternals;
}

function wakeup(id: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "ScheduleWakeup", input }] },
  } as unknown as SDKMessage;
}

async function settledBreakdown() {
  // recordLoopTick is fire-and-forget — give it a few turns to land.
  let rows = await listLoopBreakdown(CWD);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    rows = await listLoopBreakdown(CWD);
  }
  return rows;
}

describe("Session.trackScheduledLoops — ScheduleWakeup stop", () => {
  test("a stop marks the pending wake-up cancelled without arming or recording a tick", async () => {
    const session = makeSession();
    session.trackScheduledLoops(
      wakeup("toolu-arm", {
        delaySeconds: 600,
        reason: "waiting on CI",
        prompt: "<<autonomous-loop-dynamic>>",
      }),
      1000,
    );
    session.trackScheduledLoops(wakeup("toolu-stop", { stop: true }), 2000);

    const loops = session.getScheduledLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ id: "toolu-arm", kind: "wakeup", cancelled: true });
    expect(loops.find((l) => l.id === "toolu-stop")).toBeUndefined();

    const rows = await settledBreakdown();
    expect(rows).toHaveLength(1);
    expect(rows[0].runCount).toBe(1);
  });

  test("a stop with no pending wake-up creates nothing", () => {
    const session = makeSession();
    session.trackScheduledLoops(wakeup("toolu-stop", { stop: true }), 2000);
    expect(session.getScheduledLoops()).toEqual([]);
  });
});
