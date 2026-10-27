import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tmpdir } from "node:os";
import type { Job, Run } from "@/lib/server/scheduler-store";
import {
  isScheduleFormDirty,
  parseScheduleEffort,
  SCHEDULE_EFFORT_LEVELS,
  type ScheduleFormFields,
} from "@/lib/shared/schedule-form";

/**
 * CC 2.1.312 parity (cloud routines → Claudius scheduled jobs): "[Cloud
 * sessions] Added an effort level to the model picker when you create or edit
 * a routine that runs in the cloud". A scheduled job can carry an effort level.
 * The runner passes it to the SDK as `effort`, and an untrusted body can only
 * store a known level.
 */

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock("@/lib/server/notification-bus", () => ({
  notificationBus: { recordSchedulerEvent: vi.fn() },
}));

const jobs = new Map<string, Job>();
vi.mock("@/lib/server/scheduler-store", () => ({
  appendRun: vi.fn(async (_r: Run) => {}),
  updateRun: vi.fn(async (_r: Run) => {}),
  listRuns: vi.fn(async () => []),
  saveJob: vi.fn(),
  listJobs: vi.fn(async () => [...jobs.values()]),
  getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
  patchJob: vi.fn(async (id: string, patch: Partial<Job>) => {
    const cur = jobs.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    jobs.set(id, next);
    return next;
  }),
}));

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "nightly",
    cron: "0 3 * * *",
    prompt: "report",
    cwd: tmpdir(),
    enabled: false, // never armed by these tests
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

async function freshScheduler() {
  globalThis.__claudiusScheduler = undefined;
  vi.resetModules();
  return (await import("@/lib/server/scheduler")).scheduler;
}

function stream(...msgs: unknown[]) {
  return (async function* () {
    for (const m of msgs) yield m;
  })();
}

beforeEach(() => {
  jobs.clear();
  query.mockReset();
});
afterEach(() => {
  globalThis.__claudiusScheduler = undefined;
});

describe("parseScheduleEffort", () => {
  test("accepts every picker level", () => {
    for (const level of SCHEDULE_EFFORT_LEVELS) expect(parseScheduleEffort(level)).toBe(level);
  });

  test("null and empty string are an explicit clear", () => {
    expect(parseScheduleEffort(null)).toBeNull();
    expect(parseScheduleEffort("")).toBeNull();
  });

  test("anything else is rejected", () => {
    for (const v of ["auto", "HIGH", "ultra", 3, {}, [], true, undefined]) {
      expect(parseScheduleEffort(v)).toBeUndefined();
    }
  });
});

describe("isScheduleFormDirty — effort", () => {
  const base: ScheduleFormFields = { name: "", cron: "*/5 * * * *", prompt: "", cwd: "", model: "" };

  test("picking an effort makes a fresh form dirty; Default does not", () => {
    expect(isScheduleFormDirty({ ...base, effort: "" }, { ...base, effort: "" })).toBe(false);
    expect(isScheduleFormDirty({ ...base, effort: "" }, base)).toBe(false);
    expect(isScheduleFormDirty({ ...base, effort: "high" }, { ...base, effort: "" })).toBe(true);
  });
});

describe("scheduler — the job's effort reaches the SDK", () => {
  test("a job with an effort runs with `effort` set", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job({ model: "claude-opus-5-5", effort: "xhigh" }));
    query.mockReturnValue(stream({ type: "result", subtype: "success", total_cost_usd: 0 }));
    await s.runNow("j1");
    expect(query).toHaveBeenCalledTimes(1);
    const { options } = query.mock.calls[0][0] as { options: { model?: string; effort?: string } };
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("xhigh");
  });

  test("a job without one leaves `effort` unset, so the model's default applies", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job());
    query.mockReturnValue(stream({ type: "result", subtype: "success", total_cost_usd: 0 }));
    await s.runNow("j1");
    const { options } = query.mock.calls[0][0] as { options: Record<string, unknown> };
    expect("effort" in options).toBe(false);
  });
});
