import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the model-picker GET route at
 * `app/api/sessions/[id]/model/route.ts`.
 *
 * Why this exists: the first cut of the route called
 * `session.supportedModels()` — a wrapper *method* on the `Session` class.
 * That worked in production but broke in dev: Next.js Fast Refresh
 * re-evaluates the module and creates a new `Session` class, but existing
 * in-memory instances keep referencing the *old* prototype. When the
 * picker opened on a session created before the HMR pass, the call threw
 * `session.supportedModels is not a function` and the picker showed
 * "HTTP 500" forever.
 *
 * The fix in `route.ts` reads `session.query` directly — `query` is an
 * instance field assigned in `Session.start()`, so it survives HMR.
 * These tests pin down the new contract:
 *
 *   - 404 when the session id is unknown.
 *   - 503 when the session exists but has no `query` (resume in flight,
 *     reaped, or never bound).
 *   - 200 with `{ models }` when `query.supportedModels()` resolves.
 *   - 503 with the SDK's error message when `supportedModels()` throws.
 *
 * The handler is the unit under test — `sessionManager` is mocked at the
 * module level so we never spin up a real SDK process.
 */

type FakeSession = {
  query: { supportedModels: () => Promise<unknown> } | null;
};

const mockManager = {
  get: vi.fn<(id: string) => FakeSession | undefined>(),
};

vi.mock("@/lib/server/session-manager", () => ({
  sessionManager: mockManager,
}));

// Import AFTER vi.mock so the route picks up the stubbed sessionManager.
// Avoid top-level imports of the route — vitest hoists vi.mock above
// imports, but the static import would still load the manager module
// before the mock factory is registered if we placed it at the top.
const { GET } = await import("@/app/api/sessions/[id]/model/route");

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeReq(): Request {
  // The handler doesn't read the request body — any Request object works.
  return new Request("http://localhost/api/sessions/test/model");
}

describe("GET /api/sessions/[id]/model", () => {
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

  test("200 with the SDK model list, augmented with Fable when the SDK omits it", async () => {
    // The SDK gates Fable behind `isFableAvailable` in the bundled CLI
    // binary — accounts whose entitlement check hasn't propagated see no
    // `fable` row at all. The route augments the response with a static
    // `fable` alias so the picker still surfaces it; selecting it falls
    // through to `setModel` and returns 409 if the account can't use it.
    const models = [
      {
        value: "claude-opus-4-7",
        displayName: "Opus 4.7",
        description: "Deep reasoning",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      },
      {
        value: "claude-sonnet-4-6",
        displayName: "Sonnet 4.6",
        description: "Balanced",
        supportsFastMode: true,
      },
    ];
    const supportedModels = vi.fn().mockResolvedValue(models);
    mockManager.get.mockReturnValue({ query: { supportedModels } });

    const res = await GET(makeReq(), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ value: string }> };
    // SDK entries come first (preserving SDK ordering — the picker
    // treats the first row as the default-pick), Fable appended.
    expect(body.models.slice(0, 2)).toEqual(models);
    expect(body.models.at(-1)).toMatchObject({
      value: "fable",
      displayName: "Fable",
      supportsEffort: true,
    });
    expect(supportedModels).toHaveBeenCalledOnce();
  });

  test("does NOT duplicate Fable when the SDK already returns a fable-family entry", async () => {
    // When the SDK returns the pinned `claude-fable-5`, the dedup-by-
    // substring check in the route should recognise that as Fable
    // coverage and skip the augment — otherwise the picker would show
    // two rows ("Fable 5" and a generic "Fable").
    const models = [
      {
        value: "claude-fable-5",
        displayName: "Fable 5",
        description: "Extended thinking",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "claude-sonnet-4-6",
        displayName: "Sonnet 4.6",
        description: "Balanced",
      },
    ];
    const supportedModels = vi.fn().mockResolvedValue(models);
    mockManager.get.mockReturnValue({ query: { supportedModels } });

    const res = await GET(makeReq(), makeCtx("active"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: typeof models };
    expect(body.models).toEqual(models);
    expect(body.models.filter((m) => /fable/i.test(m.value))).toHaveLength(1);
  });

  test("503 with the SDK's error message when supportedModels() rejects", async () => {
    // Silence the route's console.error during the test — the handler
    // intentionally logs the underlying cause server-side for dev triage,
    // but we don't want a red `[api/sessions/model] GET failed` line
    // showing in clean test output.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockManager.get.mockReturnValue({
      query: {
        supportedModels: () => Promise.reject(new Error("transport closed")),
      },
    });

    const res = await GET(makeReq(), makeCtx("broken"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("transport closed");
    expect(errSpy).toHaveBeenCalled();
  });

  test("does NOT depend on Session.supportedModels — bypasses the prototype", async () => {
    // The regression we're guarding against: an HMR-stale Session
    // instance still has a usable `query` field but no
    // `supportedModels` method on its prototype. Simulate that by
    // returning a session object whose only property is `query`.

    const supportedModels = vi.fn().mockResolvedValue([]);
    const hmrStaleSession = { query: { supportedModels } } as FakeSession;
    // Don't add a `supportedModels` method on the session itself —
    // that's the whole point.
    mockManager.get.mockReturnValue(hmrStaleSession);

    const res = await GET(makeReq(), makeCtx("hmr-stale"));

    // Should NOT throw `session.supportedModels is not a function`.
    expect(res.status).toBe(200);
    expect(supportedModels).toHaveBeenCalledOnce();
  });
});
