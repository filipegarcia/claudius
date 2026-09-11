import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for `/api/sessions/[id]/output-style` — CC 2.1.269 parity.
 *
 * Claudius already modeled `outputStyle` as a `ClaudeSettings` field (the
 * Settings page's dropdown), but nothing forwarded a change to the running
 * SDK query, and nothing listed the SDK's `available_output_styles`
 * (including plugin-provided custom styles). This route adds both halves;
 * `Session.setOutputStyle` / `Session.outputStyles` do the real work, so
 * the route itself is a thin dispatcher — these tests pin its contract:
 *
 *   - 404 when the session id is unknown.
 *   - GET falls back to the static style list when the session has no
 *     active query (or the query rejects), so the slash command's "no
 *     args" listing always has something to show.
 *   - GET prefers the SDK's live `available_output_styles` when present.
 *   - PATCH 400s on a missing/blank body, otherwise forwards to
 *     `setOutputStyle` and surfaces its `{ ok, error }` result.
 */

type OutputStylesResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
type SetOutputStyleResult =
  | { ok: true; outputStyle: string }
  | { ok: false; error: string };

type FakeSession = {
  outputStyles: () => Promise<OutputStylesResult>;
  setOutputStyle: (name: string) => Promise<SetOutputStyleResult>;
};

const mockManager = {
  get: vi.fn<(id: string) => FakeSession | undefined>(),
};

vi.mock("@/lib/server/session-manager", () => ({
  sessionManager: mockManager,
}));

// Import AFTER vi.mock — see model-picker-route.test.ts for why (vi.mock is
// hoisted above imports, but a static top-level import of the route would
// still load the manager module before the mock factory registers).
const { GET, PATCH } = await import("@/app/api/sessions/[id]/output-style/route");

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeGetReq(): Request {
  return new Request("http://localhost/api/sessions/test/output-style");
}

function makePatchReq(body: unknown): Request {
  return new Request("http://localhost/api/sessions/test/output-style", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/sessions/[id]/output-style", () => {
  beforeEach(() => {
    mockManager.get.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("404 when the session id is unknown", async () => {
    mockManager.get.mockReturnValue(undefined);

    const res = await GET(makeGetReq(), makeCtx("missing"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("session not found");
  });

  test("falls back to the static style list when the session has no active query", async () => {
    mockManager.get.mockReturnValue({
      outputStyles: async () => ({ ok: false, error: "session not active" }),
      setOutputStyle: vi.fn(),
    });

    const res = await GET(makeGetReq(), makeCtx("idle"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; available: string[]; source: string };
    expect(body.current).toBe("default");
    expect(body.available).toEqual(["default", "explanatory", "concise", "developer"]);
    expect(body.source).toBe("fallback");
  });

  test("prefers the SDK's live available_output_styles, including custom names", async () => {
    mockManager.get.mockReturnValue({
      outputStyles: async () => ({
        ok: true,
        data: {
          output_style: "concise",
          available_output_styles: ["default", "concise", "my-plugin:reviewer-style"],
        },
      }),
      setOutputStyle: vi.fn(),
    });

    const res = await GET(makeGetReq(), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; available: string[]; source: string };
    expect(body.current).toBe("concise");
    expect(body.available).toEqual(["default", "concise", "my-plugin:reviewer-style"]);
    expect(body.source).toBe("session");
  });

  test("falls back to the static list when the SDK reports an empty available list", async () => {
    mockManager.get.mockReturnValue({
      outputStyles: async () => ({
        ok: true,
        data: { output_style: "default", available_output_styles: [] },
      }),
      setOutputStyle: vi.fn(),
    });

    const res = await GET(makeGetReq(), makeCtx("active"));

    const body = (await res.json()) as { available: string[] };
    expect(body.available).toEqual(["default", "explanatory", "concise", "developer"]);
  });
});

describe("PATCH /api/sessions/[id]/output-style", () => {
  beforeEach(() => {
    mockManager.get.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("404 when the session id is unknown", async () => {
    mockManager.get.mockReturnValue(undefined);

    const res = await PATCH(makePatchReq({ outputStyle: "concise" }), makeCtx("missing"));

    expect(res.status).toBe(404);
  });

  test("400 when outputStyle is missing or blank", async () => {
    mockManager.get.mockReturnValue({
      outputStyles: vi.fn(),
      setOutputStyle: vi.fn(),
    });

    const res = await PATCH(makePatchReq({ outputStyle: "  " }), makeCtx("active"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("outputStyle is required");
  });

  test("200 with the applied style on success", async () => {
    const setOutputStyle = vi.fn().mockResolvedValue({ ok: true, outputStyle: "explanatory" });
    mockManager.get.mockReturnValue({ outputStyles: vi.fn(), setOutputStyle });

    const res = await PATCH(makePatchReq({ outputStyle: "explanatory" }), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outputStyle: string };
    expect(body).toEqual({ ok: true, outputStyle: "explanatory" });
    expect(setOutputStyle).toHaveBeenCalledWith("explanatory");
  });

  test("500 with the underlying error when setOutputStyle fails", async () => {
    const setOutputStyle = vi.fn().mockResolvedValue({ ok: false, error: "disk full" });
    mockManager.get.mockReturnValue({ outputStyles: vi.fn(), setOutputStyle });

    const res = await PATCH(makePatchReq({ outputStyle: "concise" }), makeCtx("active"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "disk full" });
  });
});
