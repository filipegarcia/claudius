import { describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";

/**
 * Send-now (Ctrl+Enter) → SDK 0.3.286 `priority: "now"`.
 *
 * Verified live against the 0.3.286 CLI: a `priority: "now"` user message
 * only joins the running turn (backgrounding the in-flight tool) when it ALSO
 * carries `origin: { kind: "human" }`. Without the origin it waits for the
 * tool and runs as its own turn, same as an unprioritised send. So
 * `sendInput({ priority: "now" })` must push both fields, and nothing else may
 * pick them up.
 *
 * Reads the private `inputQueue` (an AsyncQueue) the same way
 * `session-interrupt-still-queued.test.ts` reaches into `query`.
 */
type Pushed = {
  type: string;
  uuid?: string;
  priority?: string;
  origin?: { kind: string };
  message: { content: unknown };
};
type SessionInternals = {
  inputQueue: { next: () => Promise<IteratorResult<Pushed>> };
  sendInput: (
    text: string,
    images?: Array<{ data: string; mediaType: string; ordinal?: number }>,
    opts?: { uuid?: string; slash?: boolean; priority?: "now" },
  ) => void;
};

let n = 0;
function makeSession(): SessionInternals {
  n += 1;
  return new Session({ id: `send-now-test-${n}`, cwd: "/tmp/fake-send-now-cwd" }) as unknown as SessionInternals;
}
async function nextPushed(session: SessionInternals): Promise<Pushed> {
  const r = await session.inputQueue.next();
  return r.value;
}

describe("Session.sendInput priority: 'now'", () => {
  test("text message carries priority 'now' AND origin human", async () => {
    const session = makeSession();
    session.sendInput("hello", undefined, { uuid: "u-1", priority: "now" });
    const pushed = await nextPushed(session);
    expect(pushed.uuid).toBe("u-1");
    expect(pushed.priority).toBe("now");
    expect(pushed.origin).toEqual({ kind: "human" });
  });

  test("image message carries both fields too", async () => {
    const session = makeSession();
    session.sendInput(
      "look [Image #1]",
      [{ data: "AAAA", mediaType: "image/png", ordinal: 1 }],
      { priority: "now" },
    );
    const pushed = await nextPushed(session);
    expect(Array.isArray(pushed.message.content)).toBe(true);
    expect(pushed.priority).toBe("now");
    expect(pushed.origin).toEqual({ kind: "human" });
  });

  test("a normal send carries neither field", async () => {
    const session = makeSession();
    session.sendInput("hello");
    const pushed = await nextPushed(session);
    expect(pushed).not.toHaveProperty("priority");
    expect(pushed).not.toHaveProperty("origin");
  });

  test("slash commands ignore priority — they always run as their own turn", async () => {
    const session = makeSession();
    session.sendInput("/compact", undefined, { slash: true, priority: "now" });
    const pushed = await nextPushed(session);
    expect(pushed.message.content).toBe("/compact");
    expect(pushed).not.toHaveProperty("priority");
    expect(pushed).not.toHaveProperty("origin");
  });
});
