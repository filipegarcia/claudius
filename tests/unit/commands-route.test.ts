import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the SDK slash-commands GET route at
 * `app/api/sessions/[id]/commands/route.ts`. Surfaces the SDK's rich
 * SlashCommand[] (name/description/argumentHint/aliases) for the picker.
 * Mirrors the loaded-agents / model-picker routes' HMR-safe contract: read
 * `session.query` directly rather than the Session prototype wrapper.
 */

type FakeSession = {
  query: { supportedCommands: () => Promise<unknown> } | null;
};

const mockManager = {
  get: vi.fn<(id: string) => FakeSession | undefined>(),
};

vi.mock("@/lib/server/session-manager", () => ({
  sessionManager: mockManager,
}));

const { GET } = await import("@/app/api/sessions/[id]/commands/route");

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeReq(): Request {
  return new Request("http://localhost/api/sessions/test/commands");
}

describe("GET /api/sessions/[id]/commands", () => {
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
    expect((await res.json()).error).toBe("session not found");
  });

  test("503 when the session has no active SDK query", async () => {
    mockManager.get.mockReturnValue({ query: null });
    const res = await GET(makeReq(), makeCtx("idle"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("session not active");
  });

  test("200 with the command list when the SDK resolves", async () => {
    const commands = [
      { name: "compact", description: "Compact the conversation", argumentHint: "[focus]" },
      { name: "usage", description: "Show usage", argumentHint: "", aliases: ["stats"] },
    ];
    const supportedCommands = vi.fn().mockResolvedValue(commands);
    mockManager.get.mockReturnValue({ query: { supportedCommands } });

    const res = await GET(makeReq(), makeCtx("active"));
    expect(res.status).toBe(200);
    expect((await res.json()).commands).toEqual(commands);
    expect(supportedCommands).toHaveBeenCalledOnce();
  });

  test("503 with the SDK's error message when supportedCommands() rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockManager.get.mockReturnValue({
      query: { supportedCommands: () => Promise.reject(new Error("transport closed")) },
    });
    const res = await GET(makeReq(), makeCtx("broken"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("transport closed");
    expect(errSpy).toHaveBeenCalled();
  });

  test("does NOT depend on Session.supportedCommands — bypasses the prototype (HMR guard)", async () => {
    const supportedCommands = vi.fn().mockResolvedValue([]);
    mockManager.get.mockReturnValue({ query: { supportedCommands } } as FakeSession);
    const res = await GET(makeReq(), makeCtx("hmr-stale"));
    expect(res.status).toBe(200);
    expect(supportedCommands).toHaveBeenCalledOnce();
  });
});
