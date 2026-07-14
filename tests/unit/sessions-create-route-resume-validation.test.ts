import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Coverage for the `resume` guard on POST /api/sessions.
 *
 * `body.resume` flows verbatim through `sessionManager.create({ resume })` →
 * `Session` → the SDK's `resume` option, which becomes a literal argument to
 * the spawned Claude Code CLI. Session ids are always `crypto.randomUUID()`
 * (see `lib/server/session.ts`), so anything that isn't UUID-shaped is either
 * a bug on our own client or a malicious cross-origin POST — reject it with
 * 400 before it ever reaches `sessionManager.create` / the SDK.
 *
 * This guard is what actually receives the claude-agent-sdk 0.3.208 fix for
 * "extraArgs/resume values that look like flags (e.g. resume: '--version')
 * being parsed as their own CLI flags": the SDK now also protects against it,
 * but this route is the reachable sink, so we validate here too rather than
 * relying solely on the dependency.
 */

const mockManager = { create: vi.fn(), get: vi.fn() };
vi.mock("@/lib/server/session-manager", () => ({ sessionManager: mockManager }));
vi.mock("@/lib/server/active-workspace", () => ({
  resolveActiveWorkspace: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/server/active-customization", () => ({
  resolveActiveCustomization: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/server/customizations-store", () => ({
  customizationSrcDir: vi.fn(() => "/tmp/customization-src"),
  customizationsRoot: vi.fn(() => "/tmp/customizations"),
}));
vi.mock("@/lib/server/workspaces-store", () => ({
  getWorkspace: vi.fn().mockResolvedValue(null),
  listWorkspaces: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/server/sessions-store", () => ({
  info: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/server/prompt-drafts-db", () => ({
  setPromptDraft: vi.fn(),
}));

// Import AFTER vi.mock so the route picks up the stubbed dependencies.
const { POST } = await import("@/app/api/sessions/route");

function req(body: unknown): Request {
  return new Request("http://localhost/api/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/sessions — resume id validation", () => {
  beforeEach(() => {
    mockManager.create.mockReset();
    mockManager.get.mockReset();
    mockManager.create.mockResolvedValue({
      getPermissionMode: () => undefined,
      setPermissionMode: vi.fn(),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test("400 when resume looks like a CLI flag, never reaches sessionManager.create", async () => {
    const res = await POST(req({ cwd: "/tmp/proj", resume: "--version" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid resume id");
    expect(mockManager.create).not.toHaveBeenCalled();
  });

  test("400 when resume is an arbitrary non-uuid string", async () => {
    const res = await POST(req({ cwd: "/tmp/proj", resume: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(mockManager.create).not.toHaveBeenCalled();
  });

  test("passes through a well-formed uuid resume id to sessionManager.create", async () => {
    const id = "c7a38ee8-cf5d-4edb-9f2f-4c301580040e";
    const res = await POST(req({ cwd: "/tmp/proj", resume: id }));
    expect(res.status).toBe(200);
    expect(mockManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ resume: id }),
    );
  });

  test("200 when resume is omitted entirely (fresh session)", async () => {
    const res = await POST(req({ cwd: "/tmp/proj" }));
    expect(res.status).toBe(200);
    expect(mockManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ resume: undefined }),
    );
  });
});
