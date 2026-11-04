import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Job } from "@/lib/server/scheduler-store";

/**
 * Rust port (rust/TODO.md G07d): when the Rust backend runs the scheduled
 * jobs, Next must not run them too (two schedulers on one jobs.json would
 * fire every job twice). `CLAUDIUS_RUST_SCHEDULER=1` makes `boot()` and
 * `arm()` no-ops; without it the scheduler behaves as before.
 */

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("@/lib/server/notification-bus", () => ({
  notificationBus: { recordSchedulerEvent: vi.fn() },
}));

const store = new Map<string, Job>();
const listJobs = vi.fn(async () => [...store.values()]);
const patchJob = vi.fn(async (id: string, patch: Partial<Job>) => {
  const cur = store.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  store.set(id, next);
  return next;
});
vi.mock("@/lib/server/scheduler-store", () => ({
  appendRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => []),
  saveJob: vi.fn(),
  listJobs: () => listJobs(),
  getJob: vi.fn(async (id: string) => store.get(id) ?? null),
  patchJob: (id: string, patch: Partial<Job>) => patchJob(id, patch),
}));

const job: Job = {
  id: "j1",
  name: "every minute",
  cron: "* * * * *",
  prompt: "hi",
  cwd: "/tmp",
  enabled: true,
  createdAt: 0,
} as Job;

async function freshScheduler() {
  const { scheduler } = await import("@/lib/server/scheduler");
  const Ctor = scheduler.constructor as new () => typeof scheduler;
  return new Ctor();
}

describe("CLAUDIUS_RUST_SCHEDULER", () => {
  const saved = process.env.CLAUDIUS_RUST_SCHEDULER;
  beforeEach(() => {
    store.clear();
    store.set(job.id, { ...job });
    listJobs.mockClear();
    patchJob.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.CLAUDIUS_RUST_SCHEDULER;
    else process.env.CLAUDIUS_RUST_SCHEDULER = saved;
  });

  test.each(["1", "true", " YES ", "on"])("%j: boot() and arm() leave the jobs to Rust", async (v) => {
    process.env.CLAUDIUS_RUST_SCHEDULER = v;
    const s = await freshScheduler();
    await s.boot();
    expect(listJobs).not.toHaveBeenCalled();
    await s.arm({ ...job });
    expect(patchJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([undefined, "", "0", "false"])("%j: boot() arms the enabled jobs as before", async (v) => {
    if (v === undefined) delete process.env.CLAUDIUS_RUST_SCHEDULER;
    else process.env.CLAUDIUS_RUST_SCHEDULER = v;
    const s = await freshScheduler();
    await s.boot();
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(patchJob).toHaveBeenCalledWith("j1", { nextRunAt: expect.any(Number) });
    expect(vi.getTimerCount()).toBe(1);
  });
});
