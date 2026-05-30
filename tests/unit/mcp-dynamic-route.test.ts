import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the dynamic-MCP route (B4.8) at
 * app/api/sessions/[id]/mcp-dynamic/route.ts — wraps Session.setMcpServers,
 * which forwards to Query.setMcpServers.
 */

type FakeSession = {
  setMcpServers: (
    servers: Record<string, unknown>,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
};

const mockManager = { get: vi.fn<(id: string) => FakeSession | undefined>() };
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: mockManager }));

const { POST } = await import("@/app/api/sessions/[id]/mcp-dynamic/route");

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

describe("POST /api/sessions/[id]/mcp-dynamic", () => {
  beforeEach(() => mockManager.get.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("404 unknown session", async () => {
    mockManager.get.mockReturnValue(undefined);
    expect((await POST(req({ servers: {} }), ctx("nope"))).status).toBe(404);
  });

  test("400 when servers is missing or not a plain object", async () => {
    mockManager.get.mockReturnValue({ setMcpServers: vi.fn() });
    expect((await POST(req({}), ctx("s1"))).status).toBe(400);
    expect((await POST(req({ servers: [] }), ctx("s1"))).status).toBe(400);
    expect((await POST(req({ servers: null }), ctx("s1"))).status).toBe(400);
  });

  test("200 forwards the servers map and relays the SDK report", async () => {
    const report = { added: ["a"], removed: [], errors: {} };
    const setMcpServers = vi.fn().mockResolvedValue({ ok: true, data: report });
    mockManager.get.mockReturnValue({ setMcpServers });
    const servers = { a: { command: "node", args: ["x.js"] } };
    const res = await POST(req({ servers }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: report });
    expect(setMcpServers).toHaveBeenCalledWith(servers);
  });

  test("empty servers object is valid (removes all dynamic servers)", async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ ok: true, data: { added: [], removed: ["a"], errors: {} } });
    mockManager.get.mockReturnValue({ setMcpServers });
    const res = await POST(req({ servers: {} }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(setMcpServers).toHaveBeenCalledWith({});
  });

  test("503 when the Session reports an error", async () => {
    const setMcpServers = vi.fn().mockResolvedValue({ ok: false, error: "no active query" });
    mockManager.get.mockReturnValue({ setMcpServers });
    const res = await POST(req({ servers: {} }), ctx("s1"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe("no active query");
  });
});
