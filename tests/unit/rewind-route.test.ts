import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the rewind POST route at `app/api/sessions/[id]/rewind/route.ts`.
 *
 * This route rewinds the working tree to a prior user message via the SDK's
 * file-checkpointing (Query.rewindFiles). It mirrors the model/agents routes'
 * HMR-safe contract: read `session.query` directly (an instance field that
 * survives Next.js Fast Refresh) rather than calling a Session wrapper method.
 *
 * Pinned behaviour:
 *   - 404 when the session id is unknown.
 *   - 400 when `userMessageId` is missing/invalid.
 *   - 503 when the session exists but has no `query` (resume in flight / reaped).
 *   - 200 with `{ result }` when `rewindFiles` resolves — including the normal
 *     `canRewind: false` case (that is NOT an HTTP error).
 *   - dryRun flag is forwarded to the SDK.
 *   - 503 with the SDK's error message when `rewindFiles` throws.
 *   - CC 2.1.331: a dead session goes through `restartIfDead` first, and the
 *     rewind runs on the rebuilt session.
 */

type FakeQuery = {
  rewindFiles: (id: string, opts?: { dryRun?: boolean }) => Promise<unknown>;
};
type FakeSession = { query: FakeQuery | null };

type RestartResult =
  | { ok: true; session: FakeSession; restarted: boolean }
  | { ok: false; reason: "gone" | "max_attempts" | "failed" | "skipped"; error?: string };

const mockManager = {
  get: vi.fn<(id: string) => FakeSession | undefined>(),
  // Default: hand back whatever `get` holds, like a live session; unknown
  // ids are "gone". CC 2.1.331 tests override it for a dead session.
  restartIfDead: vi.fn<(id: string) => Promise<RestartResult>>(),
};

vi.mock("@/lib/server/session-manager", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/session-manager")>(
    "@/lib/server/session-manager",
  );
  return { sessionManager: mockManager, deadSessionResponse: actual.deadSessionResponse };
});

const { POST } = await import("@/app/api/sessions/[id]/rewind/route");

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/sessions/test/rewind", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/sessions/[id]/rewind", () => {
  beforeEach(() => {
    mockManager.get.mockReset();
    mockManager.restartIfDead.mockReset();
    mockManager.restartIfDead.mockImplementation(async (id: string) => {
      const session = mockManager.get(id);
      return session ? { ok: true, session, restarted: false } : { ok: false, reason: "gone" };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("404 when the session id is unknown", async () => {
    mockManager.get.mockReturnValue(undefined);

    const res = await POST(makeReq({ userMessageId: "u1" }), makeCtx("missing"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session not found");
  });

  test("400 when userMessageId is missing", async () => {
    mockManager.get.mockReturnValue({ query: { rewindFiles: vi.fn() } });

    const res = await POST(makeReq({ dryRun: true }), makeCtx("active"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("userMessageId required");
  });

  test("503 when the session has no active SDK query", async () => {
    mockManager.get.mockReturnValue({ query: null });

    const res = await POST(makeReq({ userMessageId: "u1" }), makeCtx("idle"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session not active");
  });

  test("200 with the SDK result and forwards dryRun: true", async () => {
    const result = { canRewind: true, filesChanged: ["a.ts", "b.ts"], insertions: 3, deletions: 1 };
    const rewindFiles = vi.fn().mockResolvedValue(result);
    mockManager.get.mockReturnValue({ query: { rewindFiles } });

    const res = await POST(makeReq({ userMessageId: "u1", dryRun: true }), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: typeof result };
    expect(body.result).toEqual(result);
    expect(rewindFiles).toHaveBeenCalledWith("u1", { dryRun: true });
  });

  test("defaults dryRun to false when omitted (performs the rewind)", async () => {
    const rewindFiles = vi.fn().mockResolvedValue({ canRewind: true });
    mockManager.get.mockReturnValue({ query: { rewindFiles } });

    await POST(makeReq({ userMessageId: "u9" }), makeCtx("active"));

    expect(rewindFiles).toHaveBeenCalledWith("u9", { dryRun: false });
  });

  test("200 with canRewind:false is a normal response, not an HTTP error", async () => {
    const result = { canRewind: false, error: "no checkpoint for that message" };
    mockManager.get.mockReturnValue({ query: { rewindFiles: vi.fn().mockResolvedValue(result) } });

    const res = await POST(makeReq({ userMessageId: "u1" }), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: typeof result };
    expect(body.result.canRewind).toBe(false);
    expect(body.result.error).toBe("no checkpoint for that message");
  });

  test("forwards SDK 0.3.216 skippedLinks unchanged on a real rewind", async () => {
    const result = {
      canRewind: true,
      filesChanged: ["a.ts"],
      insertions: 2,
      deletions: 0,
      skippedLinks: 3,
    };
    const rewindFiles = vi.fn().mockResolvedValue(result);
    mockManager.get.mockReturnValue({ query: { rewindFiles } });

    const res = await POST(makeReq({ userMessageId: "u1", dryRun: false }), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: typeof result };
    expect(body.result.skippedLinks).toBe(3);
    expect(rewindFiles).toHaveBeenCalledWith("u1", { dryRun: false });
  });

  test("503 with the SDK's error message when rewindFiles rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockManager.get.mockReturnValue({
      query: { rewindFiles: () => Promise.reject(new Error("checkpoint store corrupt")) },
    });

    const res = await POST(makeReq({ userMessageId: "u1" }), makeCtx("broken"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("checkpoint store corrupt");
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("POST /api/sessions/[id]/rewind after the process ended (CC 2.1.331)", () => {
  beforeEach(() => {
    mockManager.get.mockReset();
    mockManager.restartIfDead.mockReset();
  });

  test("a dead session is restarted first and the rewind runs on the rebuilt one", async () => {
    const deadRewind = vi.fn().mockRejectedValue(new Error("ProcessTransport is not ready for writing"));
    const liveRewind = vi.fn().mockResolvedValue({ canRewind: true, filesChanged: ["a.ts"] });
    mockManager.get.mockReturnValue({ query: { rewindFiles: deadRewind } });
    mockManager.restartIfDead.mockResolvedValue({
      ok: true,
      session: { query: { rewindFiles: liveRewind } },
      restarted: true,
    });

    const res = await POST(makeReq({ userMessageId: "u1", dryRun: true }), makeCtx("dead"));

    expect(res.status).toBe(200);
    expect(mockManager.restartIfDead).toHaveBeenCalledWith("dead");
    expect(liveRewind).toHaveBeenCalledWith("u1", { dryRun: true });
    expect(deadRewind).not.toHaveBeenCalled();
  });

  test("a restart that fails answers with the input route's dead-session error", async () => {
    mockManager.restartIfDead.mockResolvedValue({ ok: false, reason: "failed", error: "spawn ENOENT" });

    const res = await POST(makeReq({ userMessageId: "u1" }), makeCtx("dead"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Couldn't restart the session: spawn ENOENT");
  });

  test("a malformed body is refused before anything is restarted", async () => {
    const res = await POST(makeReq({ dryRun: true }), makeCtx("dead"));

    expect(res.status).toBe(400);
    expect(mockManager.restartIfDead).not.toHaveBeenCalled();
  });
});
