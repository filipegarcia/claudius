import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import {
  enqueueTail,
  holdAll,
  listQueue,
  popHead,
  releaseHolds,
} from "@/lib/server/queued-messages-db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.316 parity — "Self-hosted runner: Fixed a message sent while Claude
 * was working being answered after a Stop, once the session's process had
 * been replaced".
 *
 * Stop leaves mid-turn queued messages in `queued_messages`, and a live
 * Session only drains after a successful turn. A replacement Session
 * (restartIfDead / restartInPlace / reaper revival / server restart) drains
 * at the end of `start()` — so `interrupt()` now marks the queue held, and
 * the `start()` drain (`flushQueueIfIdle({ unlessHeld: true })`) leaves a
 * held head in place. A successful turn or a fresh enqueue releases the hold;
 * an explicit "Send now" sends a held row regardless.
 *
 * Reaches into Session privates through a standalone shape cast via
 * `unknown`, like `session-interrupt-still-queued.test.ts`. `sendInput` is
 * spied so nothing needs the SDK subprocess; "nothing was sent" is asserted
 * from the spy plus the DB, never by awaiting an empty input queue.
 */

const CWD = "/tmp/fake-queue-held-after-stop-cwd";

type SessionInternals = {
  query: { interrupt: () => Promise<undefined> } | null;
  turnInFlight: boolean;
  interrupt: () => Promise<{ stillQueued: string[] }>;
  enqueueMessage: (input: { text: string; uuid?: string }) => Promise<string>;
  sendQueuedNow: (uuid: string) => Promise<boolean>;
  flushQueueIfIdle: (opts?: { unlessHeld?: boolean }) => Promise<void>;
  drainQueueAfterSuccess: () => Promise<void>;
  sendInput: (text: string, images?: unknown, opts?: { uuid?: string }) => void;
};

let tmp: TmpHome;
let n = 0;
let sessionId = "";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
  n += 1;
  sessionId = `queue-held-test-${n}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  tmp.restore();
});

function makeSession(): { session: SessionInternals; sent: ReturnType<typeof vi.fn> } {
  const session = new Session({ id: sessionId, cwd: CWD }) as unknown as SessionInternals;
  const sent = vi.fn();
  vi.spyOn(session, "sendInput").mockImplementation((text: string, _images?: unknown, opts?: { uuid?: string }) => {
    sent(text, opts?.uuid);
  });
  return { session, sent };
}

/** A Session mid-turn with one message queued behind the turn, then Stopped. */
async function stopWithQueued(texts: string[]): Promise<void> {
  const { session } = makeSession();
  session.query = { interrupt: async () => undefined };
  session.turnInFlight = true;
  for (const [i, text] of texts.entries()) {
    await session.enqueueMessage({ text, uuid: `q-${i}` });
  }
  await session.interrupt();
  session.turnInFlight = false;
}

describe("Stop on a working turn holds the queue (CC 2.1.316)", () => {
  test("interrupt marks every queued row held", async () => {
    await stopWithQueued(["first", "second"]);
    const rows = await listQueue(CWD, sessionId);
    expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
    expect(rows.every((r) => r.heldByStop)).toBe(true);
  });

  test("a Stop while idle holds nothing", async () => {
    const { session } = makeSession();
    session.query = { interrupt: async () => undefined };
    await session.enqueueMessage({ text: "staged", uuid: "q-idle" });
    await session.interrupt();
    const rows = await listQueue(CWD, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].heldByStop).toBe(false);
  });

  test("a replacement Session's start() drain does not send a held row", async () => {
    await stopWithQueued(["answer me later"]);
    const { session: replaced, sent } = makeSession();
    await replaced.flushQueueIfIdle({ unlessHeld: true });
    expect(sent).not.toHaveBeenCalled();
    const rows = await listQueue(CWD, sessionId);
    expect(rows.map((r) => r.text)).toEqual(["answer me later"]);
    expect(rows[0].heldByStop).toBe(true);
  });

  test("control: the start() drain still sends a row nobody stopped behind", async () => {
    await enqueueTail(CWD, { sessionId, uuid: "q-free", text: "not stopped" });
    const { session, sent } = makeSession();
    await session.flushQueueIfIdle({ unlessHeld: true });
    expect(sent).toHaveBeenCalledWith("not stopped", "q-free");
    expect(await listQueue(CWD, sessionId)).toHaveLength(0);
  });

  test("a successful turn releases the hold and drains the head", async () => {
    await stopWithQueued(["first", "second"]);
    const { session, sent } = makeSession();
    await session.drainQueueAfterSuccess();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith("first", "q-0");
    const rows = await listQueue(CWD, sessionId);
    expect(rows.map((r) => r.text)).toEqual(["second"]);
    expect(rows[0].heldByStop).toBe(false);
  });

  test("Send now still sends a held row", async () => {
    await stopWithQueued(["urgent"]);
    const { session, sent } = makeSession();
    await expect(session.sendQueuedNow("q-0")).resolves.toBe(true);
    expect(sent).toHaveBeenCalledWith("urgent", "q-0");
    expect(await listQueue(CWD, sessionId)).toHaveLength(0);
  });

  test("a fresh message from the user releases the hold", async () => {
    await stopWithQueued(["before stop"]);
    const { session, sent } = makeSession();
    await session.enqueueMessage({ text: "after stop", uuid: "q-fresh" });
    const rows = await listQueue(CWD, sessionId);
    expect(rows.map((r) => [r.text, r.heldByStop])).toEqual([
      ["before stop", false],
      ["after stop", false],
    ]);
    await session.flushQueueIfIdle({ unlessHeld: true });
    expect(sent).toHaveBeenCalledWith("before stop", "q-0");
  });
});

describe("queued-messages-db hold / release", () => {
  test("round-trips the held flag and gates popHead({ unlessHeld })", async () => {
    const a = await enqueueTail(CWD, { sessionId, uuid: "a", text: "A" });
    await enqueueTail(CWD, { sessionId, uuid: "b", text: "B" });
    await enqueueTail(CWD, { sessionId: "other-session", uuid: "c", text: "C" });
    expect(a.heldByStop).toBe(false);

    expect(await holdAll(CWD, sessionId)).toBe(2);
    expect((await listQueue(CWD, sessionId)).map((r) => r.heldByStop)).toEqual([true, true]);
    expect((await listQueue(CWD, "other-session"))[0].heldByStop).toBe(false);

    expect(await popHead(CWD, sessionId, { unlessHeld: true })).toBeNull();
    expect(await listQueue(CWD, sessionId)).toHaveLength(2);

    expect(await releaseHolds(CWD, sessionId)).toBe(2);
    expect(await releaseHolds(CWD, sessionId)).toBe(0);
    const head = await popHead(CWD, sessionId, { unlessHeld: true });
    expect(head?.text).toBe("A");
    expect(head?.heldByStop).toBe(false);
  });

  test("a plain popHead ignores the hold", async () => {
    await enqueueTail(CWD, { sessionId, uuid: "a", text: "A" });
    await holdAll(CWD, sessionId);
    const head = await popHead(CWD, sessionId);
    expect(head?.text).toBe("A");
    expect(head?.heldByStop).toBe(true);
  });
});
