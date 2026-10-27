import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Job } from "@/lib/server/scheduler-store";

/**
 * CC 2.1.312 — the schedule create/patch routes store a job's effort level
 * only when it is a known level. The body is untrusted JSON.
 */

const saved: Job[] = [];
const mockScheduler = {
  boot: vi.fn(async () => {}),
  saveJob: vi.fn(async (j: Job) => {
    saved.push(j);
  }),
  arm: vi.fn(async () => {}),
  disarm: vi.fn(),
};
vi.mock("@/lib/server/scheduler", () => ({ scheduler: mockScheduler }));
vi.mock("@/lib/server/trusted-cwd", () => ({ resolveTrustedCwd: vi.fn(async () => "/trusted") }));
const patchJob = vi.fn(async (id: string, patch: Partial<Job>) => ({ id, enabled: false, ...patch }) as Job);
vi.mock("@/lib/server/scheduler-store", () => ({
  patchJob: (id: string, patch: Partial<Job>) => patchJob(id, patch),
  deleteJob: vi.fn(),
}));

const { POST } = await import("@/app/api/schedule/route");
const { PATCH } = await import("@/app/api/schedule/[id]/route");

function post(body: unknown): Request {
  return new Request("http://localhost/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const base = { name: "nightly", cron: "0 3 * * *", prompt: "report", cwd: "/trusted" };

beforeEach(() => {
  saved.length = 0;
  patchJob.mockClear();
});

describe("POST /api/schedule — effort", () => {
  test("stores a known level", async () => {
    const res = await POST(post({ ...base, effort: "high" }));
    expect(res.status).toBe(201);
    expect(saved[0].effort).toBe("high");
  });

  test("absent or empty means no effort on the job", async () => {
    expect((await POST(post(base))).status).toBe(201);
    expect((await POST(post({ ...base, effort: "" }))).status).toBe(201);
    expect(saved.every((j) => !("effort" in j))).toBe(true);
  });

  test("an unknown level is a 400 and nothing is saved", async () => {
    const res = await POST(post({ ...base, effort: "ultra" }));
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});

describe("PATCH /api/schedule/[id] — effort", () => {
  const ctx = { params: Promise.resolve({ id: "j1" }) };
  function patch(body: unknown): Request {
    return new Request("http://localhost/api/schedule/j1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("sets and clears the level", async () => {
    expect((await PATCH(patch({ effort: "max" }), ctx)).status).toBe(200);
    expect(patchJob.mock.calls[0][1].effort).toBe("max");
    expect((await PATCH(patch({ effort: null }), ctx)).status).toBe(200);
    const cleared = patchJob.mock.calls[1][1];
    expect("effort" in cleared && cleared.effort === undefined).toBe(true);
  });

  test("an unknown level is a 400 and the job is untouched", async () => {
    const res = await PATCH(patch({ effort: 7 }), ctx);
    expect(res.status).toBe(400);
    expect(patchJob).not.toHaveBeenCalled();
  });

  test("a patch without effort leaves it alone", async () => {
    await PATCH(patch({ name: "renamed" }), ctx);
    expect("effort" in patchJob.mock.calls[0][1]).toBe(false);
  });
});
