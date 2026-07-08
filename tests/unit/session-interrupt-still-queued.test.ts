import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SDK 0.3.205: `Query.interrupt()` now resolves to the typed interrupt
 * receipt (`{ still_queued: string[] }`) on CLIs advertising the
 * `interrupt_receipt_v1` capability instead of `undefined`. `still_queued`
 * lists async user messages — e.g. a mid-turn follow-up `sendInput` already
 * pushed onto `inputQueue` before the interrupt landed (see the
 * "wasMidTurn" nudge in `sendInput`) — that will still run despite the
 * Stop. `Session.interrupt()` forwards this to the `/interrupt` route so
 * the client can tell the user their Stop didn't fully cancel pending
 * input. This test reaches into the private `query` field the same way
 * session-tasks.test.ts does, so it can stand in a fake `Query` without
 * spinning up the real SDK subprocess.
 */

const CWD = "/tmp/fake-session-interrupt-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type SessionInternals = {
  query: { interrupt: () => Promise<{ still_queued: string[] } | undefined> } | null;
  interrupt: () => Promise<{ stillQueued: string[] }>;
};

function makeSession(): SessionInternals {
  return new Session({ id: "interrupt-test", cwd: CWD }) as unknown as SessionInternals;
}

describe("Session.interrupt", () => {
  test("no active query resolves to an empty stillQueued list", async () => {
    const session = makeSession();
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });

  test("forwards a non-empty still_queued receipt from the SDK", async () => {
    const session = makeSession();
    session.query = {
      interrupt: async () => ({ still_queued: ["uuid-1", "uuid-2"] }),
    };
    await expect(session.interrupt()).resolves.toEqual({
      stillQueued: ["uuid-1", "uuid-2"],
    });
  });

  test("older-CLI undefined receipt degrades to an empty list", async () => {
    const session = makeSession();
    session.query = { interrupt: async () => undefined };
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });

  test("a rejected interrupt() degrades to an empty list rather than throwing", async () => {
    const session = makeSession();
    session.query = {
      interrupt: async () => {
        throw new Error("boom");
      },
    };
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });
});
