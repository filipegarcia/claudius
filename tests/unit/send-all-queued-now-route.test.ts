import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * POST /api/sessions/[id]/queue/send-all — the Ctrl+Enter send-now key.
 *
 * Claude Code 2.1.281 changed send-now from "interrupt the turn" to "move
 * running tools to the background and join the turn"; SDK 0.3.286 exposes
 * that to hosts as `priority: "now"`. The route must therefore NOT interrupt,
 * and must hand `priority: "now"` to every queued message up to (not
 * including) the first slash command, which can't join a running turn.
 */

type QueuedMeta = { uuid: string; text: string; slash?: boolean; createdAtMs: number };
type FakeSession = {
  interrupt: ReturnType<typeof vi.fn>;
  getQueueSnapshot: () => Promise<QueuedMeta[]>;
  sendQueuedNow: ReturnType<typeof vi.fn>;
};

const mockManager = { get: vi.fn<(id: string) => FakeSession | undefined>() };
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: mockManager }));

const { POST } = await import("@/app/api/sessions/[id]/queue/send-all/route");

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req() {
  return new Request("http://localhost/x", { method: "POST" });
}
function fakeSession(queue: QueuedMeta[], sendResult: (uuid: string) => boolean = () => true): FakeSession {
  return {
    interrupt: vi.fn().mockResolvedValue({ stillQueued: [] }),
    getQueueSnapshot: async () => queue,
    sendQueuedNow: vi.fn(async (uuid: string) => sendResult(uuid)),
  };
}
const item = (uuid: string, slash?: boolean): QueuedMeta => ({
  uuid,
  text: uuid,
  createdAtMs: 0,
  ...(slash ? { slash: true } : {}),
});

describe("POST /api/sessions/[id]/queue/send-all", () => {
  beforeEach(() => mockManager.get.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("404 for an unknown session", async () => {
    mockManager.get.mockReturnValue(undefined);
    const res = await POST(req(), ctx("nope"));
    expect(res.status).toBe(404);
  });

  test("does not interrupt the running turn", async () => {
    const s = fakeSession([item("a"), item("b")]);
    mockManager.get.mockReturnValue(s);
    await POST(req(), ctx("s1"));
    expect(s.interrupt).not.toHaveBeenCalled();
  });

  test("sends every queued message FIFO with priority 'now'", async () => {
    const s = fakeSession([item("a"), item("b"), item("c")]);
    mockManager.get.mockReturnValue(s);
    const res = await POST(req(), ctx("s1"));
    expect(res.status).toBe(200);
    expect(s.sendQueuedNow.mock.calls).toEqual([
      ["a", { priority: "now" }],
      ["b", { priority: "now" }],
      ["c", { priority: "now" }],
    ]);
    await expect(res.json()).resolves.toEqual({ ok: true, dispatched: ["a", "b", "c"] });
  });

  test("the first slash command and everything after it run as their own turns, in order", async () => {
    const s = fakeSession([item("a"), item("/compact", true), item("b")]);
    mockManager.get.mockReturnValue(s);
    await POST(req(), ctx("s1"));
    expect(s.sendQueuedNow.mock.calls).toEqual([
      ["a", { priority: "now" }],
      ["/compact", undefined],
      ["b", undefined],
    ]);
  });

  test("uuids already gone (raced by another tab) are skipped from `dispatched`", async () => {
    const s = fakeSession([item("a"), item("gone"), item("c")], (uuid) => uuid !== "gone");
    mockManager.get.mockReturnValue(s);
    const res = await POST(req(), ctx("s1"));
    await expect(res.json()).resolves.toEqual({ ok: true, dispatched: ["a", "c"] });
  });

  test("empty queue is a no-op (no interrupt, nothing sent)", async () => {
    const s = fakeSession([]);
    mockManager.get.mockReturnValue(s);
    const res = await POST(req(), ctx("s1"));
    expect(s.interrupt).not.toHaveBeenCalled();
    expect(s.sendQueuedNow).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ ok: true, dispatched: [] });
  });
});
