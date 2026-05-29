import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the B2.4 task-control routes:
 *   POST /api/sessions/[id]/stop-task       → Session.stopTask(taskId)
 *   POST /api/sessions/[id]/background-task  → Session.backgroundTasks(toolUseId?)
 *
 * Both go through the Session wrapper (which returns the {ok}/{ok:false}
 * envelope) rather than the raw query, so we mock the session manager to
 * return a fake Session with those methods.
 */

type FakeSession = {
  stopTask: (taskId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  backgroundTasks: (
    toolUseId?: string,
  ) => Promise<{ ok: true; backgrounded: boolean } | { ok: false; error: string }>;
};

const mockManager = { get: vi.fn<(id: string) => FakeSession | undefined>() };
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: mockManager }));

const { POST: stopPost } = await import("@/app/api/sessions/[id]/stop-task/route");
const { POST: bgPost } = await import("@/app/api/sessions/[id]/background-task/route");

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/sessions/[id]/stop-task", () => {
  beforeEach(() => mockManager.get.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("404 unknown session", async () => {
    mockManager.get.mockReturnValue(undefined);
    const res = await stopPost(req({ taskId: "t1" }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  test("400 when taskId missing", async () => {
    mockManager.get.mockReturnValue({ stopTask: vi.fn(), backgroundTasks: vi.fn() } as FakeSession);
    const res = await stopPost(req({}), ctx("s1"));
    expect(res.status).toBe(400);
  });

  test("200 and forwards the taskId to Session.stopTask", async () => {
    const stopTask = vi.fn().mockResolvedValue({ ok: true });
    mockManager.get.mockReturnValue({ stopTask, backgroundTasks: vi.fn() } as FakeSession);
    const res = await stopPost(req({ taskId: "task-42" }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(stopTask).toHaveBeenCalledWith("task-42");
  });

  test("503 when the Session reports an error (no active query / SDK throw)", async () => {
    const stopTask = vi.fn().mockResolvedValue({ ok: false, error: "no active query" });
    mockManager.get.mockReturnValue({ stopTask, backgroundTasks: vi.fn() } as FakeSession);
    const res = await stopPost(req({ taskId: "t1" }), ctx("s1"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe("no active query");
  });
});

describe("POST /api/sessions/[id]/background-task", () => {
  beforeEach(() => mockManager.get.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("404 unknown session", async () => {
    mockManager.get.mockReturnValue(undefined);
    const res = await bgPost(req({}), ctx("nope"));
    expect(res.status).toBe(404);
  });

  test("200 backgrounding all foreground tasks (no toolUseId) → undefined forwarded", async () => {
    const backgroundTasks = vi.fn().mockResolvedValue({ ok: true, backgrounded: true });
    mockManager.get.mockReturnValue({ stopTask: vi.fn(), backgroundTasks } as FakeSession);
    const res = await bgPost(req({}), ctx("s1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, backgrounded: true });
    expect(backgroundTasks).toHaveBeenCalledWith(undefined);
  });

  test("forwards a specific toolUseId; relays backgrounded:false", async () => {
    const backgroundTasks = vi.fn().mockResolvedValue({ ok: true, backgrounded: false });
    mockManager.get.mockReturnValue({ stopTask: vi.fn(), backgroundTasks } as FakeSession);
    const res = await bgPost(req({ toolUseId: "tu_9" }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { backgrounded: boolean }).backgrounded).toBe(false);
    expect(backgroundTasks).toHaveBeenCalledWith("tu_9");
  });

  test("503 when the Session reports an error", async () => {
    const backgroundTasks = vi.fn().mockResolvedValue({ ok: false, error: "no active query" });
    mockManager.get.mockReturnValue({ stopTask: vi.fn(), backgroundTasks } as FakeSession);
    const res = await bgPost(req({}), ctx("s1"));
    expect(res.status).toBe(503);
  });
});
