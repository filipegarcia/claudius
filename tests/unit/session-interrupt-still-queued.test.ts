import { describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";

/**
 * SDK 0.3.205 — `Query.interrupt()` now resolves to a typed receipt
 * (`{ still_queued: string[] }`) on a CLI advertising the
 * `interrupt_receipt_v1` capability, instead of always resolving to
 * `undefined`. `Session.interrupt()` forwards `still_queued` (or `[]` when
 * there's no active query, the CLI is older, or the SDK call rejects) so the
 * `/interrupt` route — and the client's "Stop: N queued messages will still
 * run" pill — can surface it.
 *
 * Reaches into the private `query` field the same way
 * `session-tasks.test.ts` does: a standalone shape cast through `unknown`,
 * never an intersection with the class, so we can stand in a fake `Query`
 * without spinning up the real SDK subprocess.
 */
type SessionInternals = {
  query: { interrupt: () => Promise<{ still_queued: string[] } | undefined> } | null;
  interrupt: () => Promise<{ stillQueued: string[] }>;
};

function makeSession(): SessionInternals {
  return new Session({ id: "interrupt-test", cwd: "/tmp/fake-interrupt-cwd" }) as unknown as SessionInternals;
}

describe("Session.interrupt()", () => {
  test("no active query resolves to an empty list", async () => {
    const session = makeSession();
    session.query = null;
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });

  test("forwards a non-empty still_queued receipt verbatim", async () => {
    const session = makeSession();
    session.query = {
      interrupt: async () => ({ still_queued: ["uuid-1", "uuid-2"] }),
    };
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: ["uuid-1", "uuid-2"] });
  });

  test("an older CLI's undefined receipt degrades to []", async () => {
    const session = makeSession();
    session.query = {
      interrupt: async () => undefined,
    };
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });

  test("a rejected interrupt() degrades to [] rather than throwing", async () => {
    const session = makeSession();
    session.query = {
      interrupt: async () => {
        throw new Error("boom");
      },
    };
    await expect(session.interrupt()).resolves.toEqual({ stillQueued: [] });
  });
});
