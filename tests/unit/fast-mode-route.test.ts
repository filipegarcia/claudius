import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the "fast mode" session toggle route:
 *   POST /api/sessions/[id]/fast → Session.setFast(enabled)
 *
 * Fast mode is the SDK's accelerated-decoding flag (Opus 4.8). The route is a
 * thin mirror of the ultracode/effort routes: validate the body, look up the
 * session, forward verbatim to `Session.setFast`, which calls
 * `query.applyFlagSettings({ fastMode })`. Unlike stop-task/background-task it
 * has NO 503 path — `setFast` returns void and the route ignores it, always
 * returning 200 once the session exists and the body is a boolean.
 *
 * The handler is the unit under test; `sessionManager` is mocked so we never
 * spin up a real SDK process.
 */

type FakeSession = {
  setFast: (enabled: boolean) => Promise<void>;
};

const mockManager = { get: vi.fn<(id: string) => FakeSession | undefined>() };
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: mockManager }));

// Import AFTER vi.mock so the route picks up the stubbed sessionManager.
const { POST } = await import("@/app/api/sessions/[id]/fast/route");

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

describe("POST /api/sessions/[id]/fast", () => {
  beforeEach(() => mockManager.get.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("404 when the session id is unknown", async () => {
    mockManager.get.mockReturnValue(undefined);
    const res = await POST(req({ enabled: true }), ctx("nope"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("session not found");
    expect(mockManager.get).toHaveBeenCalledWith("nope");
  });

  test("400 when 'enabled' is missing", async () => {
    const setFast = vi.fn().mockResolvedValue(undefined);
    mockManager.get.mockReturnValue({ setFast });
    const res = await POST(req({}), ctx("s1"));
    expect(res.status).toBe(400);
    // Never reach the SDK on a bad body.
    expect(setFast).not.toHaveBeenCalled();
  });

  test("400 when 'enabled' is a non-boolean", async () => {
    const setFast = vi.fn().mockResolvedValue(undefined);
    mockManager.get.mockReturnValue({ setFast });
    const res = await POST(req({ enabled: "yes" }), ctx("s1"));
    expect(res.status).toBe(400);
    expect(setFast).not.toHaveBeenCalled();
  });

  test("200 forwards enabled:true to Session.setFast and echoes it", async () => {
    const setFast = vi.fn().mockResolvedValue(undefined);
    mockManager.get.mockReturnValue({ setFast });
    const res = await POST(req({ enabled: true }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: true });
    expect(setFast).toHaveBeenCalledWith(true);
  });

  test("200 forwards enabled:false (catches a hardcoded-true bug)", async () => {
    const setFast = vi.fn().mockResolvedValue(undefined);
    mockManager.get.mockReturnValue({ setFast });
    const res = await POST(req({ enabled: false }), ctx("s1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(setFast).toHaveBeenCalledWith(false);
  });
});
