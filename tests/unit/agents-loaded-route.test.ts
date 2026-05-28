import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the loaded-agents GET route at
 * `app/api/sessions/[id]/agents/route.ts`.
 *
 * This route surfaces the SDK's live subagent list (AgentInfo[]) — file-based,
 * plugin-injected, and built-in — for the /agents page banner. It mirrors the
 * model-picker route's HMR-safe contract: read `session.query` directly (an
 * instance field that survives Next.js Fast Refresh) rather than calling the
 * `Session.supportedAgents()` wrapper method (a prototype member that an
 * HMR-stale instance no longer has).
 *
 * Pinned behaviour:
 *   - 404 when the session id is unknown.
 *   - 503 when the session exists but has no `query` (resume in flight / reaped).
 *   - 200 with `{ agents }` when `query.supportedAgents()` resolves.
 *   - 503 with the SDK's error message when `supportedAgents()` throws.
 *   - The handler does NOT depend on Session.supportedAgents (HMR guard).
 *
 * `sessionManager` is mocked at module level so no real SDK process spawns.
 */

type FakeSession = {
  query: { supportedAgents: () => Promise<unknown> } | null;
};

const mockManager = {
  get: vi.fn<(id: string) => FakeSession | undefined>(),
};

vi.mock("@/lib/server/session-manager", () => ({
  sessionManager: mockManager,
}));

// Import AFTER vi.mock so the route picks up the stubbed sessionManager.
const { GET } = await import("@/app/api/sessions/[id]/agents/route");

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeReq(): Request {
  return new Request("http://localhost/api/sessions/test/agents");
}

describe("GET /api/sessions/[id]/agents", () => {
  beforeEach(() => {
    mockManager.get.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("404 when the session id is unknown", async () => {
    mockManager.get.mockReturnValue(undefined);

    const res = await GET(makeReq(), makeCtx("missing"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session not found");
    expect(mockManager.get).toHaveBeenCalledWith("missing");
  });

  test("503 when the session has no active SDK query (not yet bound or reaped)", async () => {
    mockManager.get.mockReturnValue({ query: null });

    const res = await GET(makeReq(), makeCtx("idle"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session not active");
  });

  test("200 with the agent list when the SDK resolves", async () => {
    const agents = [
      { name: "general-purpose", description: "Catch-all agent" },
      { name: "Explore", description: "Read-only search agent", model: "haiku" },
      { name: "code-reviewer", description: "Reviews diffs" },
    ];
    const supportedAgents = vi.fn().mockResolvedValue(agents);
    mockManager.get.mockReturnValue({ query: { supportedAgents } });

    const res = await GET(makeReq(), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: typeof agents };
    expect(body.agents).toEqual(agents);
    expect(supportedAgents).toHaveBeenCalledOnce();
  });

  test("503 with the SDK's error message when supportedAgents() rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockManager.get.mockReturnValue({
      query: {
        supportedAgents: () => Promise.reject(new Error("transport closed")),
      },
    });

    const res = await GET(makeReq(), makeCtx("broken"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("transport closed");
    expect(errSpy).toHaveBeenCalled();
  });

  test("does NOT depend on Session.supportedAgents — bypasses the prototype (HMR guard)", async () => {
    const supportedAgents = vi.fn().mockResolvedValue([]);
    // An HMR-stale Session keeps a usable `query` field but no
    // `supportedAgents` method on its (replaced) prototype.
    const hmrStaleSession = { query: { supportedAgents } } as FakeSession;
    mockManager.get.mockReturnValue(hmrStaleSession);

    const res = await GET(makeReq(), makeCtx("hmr-stale"));

    expect(res.status).toBe(200);
    expect(supportedAgents).toHaveBeenCalledOnce();
  });
});
