import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { enqueueTail, listQueue } from "@/lib/server/queued-messages-db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.318 parity — "Fixed a restarted session re-sending a message that
 * failed with an API error, ahead of the newer message waiting behind it".
 *
 * Claudius's thinking-replay 400 recovery (`recoverInPlace`) tears the
 * session down and re-sends the failed prompt in a rebuilt one. The poisoned
 * turn still ends with `subtype: "success"` (plus `is_error: true`), so the
 * old session drained the next queued message into the process about to be
 * torn down — losing it and putting the re-sent prompt ahead of it. A session
 * scheduled for recovery now leaves the queue alone.
 */
const CWD = "/tmp/fake-recovery-queue-order-cwd";

type Internals = {
  turnInFlight: boolean;
  thinkingReplayRecoveryScheduled: boolean;
  flushQueueIfIdle: (opts?: { unlessHeld?: boolean }) => Promise<void>;
  sendInput: (text: string, images?: unknown, opts?: { uuid?: string }) => void;
};

let tmp: TmpHome;
let n = 0;
let id = "";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
  n += 1;
  id = `recovery-queue-${n}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.restore();
});

function makeSession() {
  const s = new Session({ id, cwd: CWD }) as unknown as Internals;
  const sent = vi.fn();
  vi.spyOn(s, "sendInput").mockImplementation((text: string) => sent(text));
  return { s, sent };
}

describe("thinking-replay recovery leaves the queue for the rebuilt session", () => {
  test("a session scheduled for recovery doesn't drain the next queued message", async () => {
    await enqueueTail(CWD, { sessionId: id, uuid: `q-${id}`, text: "newer message B" });
    const { s, sent } = makeSession();
    s.thinkingReplayRecoveryScheduled = true;
    await s.flushQueueIfIdle();
    expect(sent).not.toHaveBeenCalled();
    expect((await listQueue(CWD, id)).map((r) => r.text)).toEqual(["newer message B"]);
  });

  test("an ordinary idle session still drains it", async () => {
    await enqueueTail(CWD, { sessionId: id, uuid: `q-${id}`, text: "newer message B" });
    const { s, sent } = makeSession();
    await s.flushQueueIfIdle();
    expect(sent).toHaveBeenCalledWith("newer message B");
    expect(await listQueue(CWD, id)).toEqual([]);
  });
});
