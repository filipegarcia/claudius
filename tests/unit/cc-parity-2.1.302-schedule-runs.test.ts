import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, Run } from "@/lib/server/scheduler-store";
import {
  activeSkip,
  runNoteText,
  RUN_ENDED_WITHOUT_RESULT,
  RUN_INTERRUPTED,
  SKIP_FOLDER_MISSING,
  SKIP_PREVIOUS_RUN,
} from "@/lib/shared/schedule-skip";

/**
 * CC 2.1.302 parity (cloud routines → Claudius scheduled jobs):
 *  - "Added a banner on a routine's page that says why its last run didn't start"
 *  - "Fixed routine runs showing as Completed after their cloud session stopped
 *    unexpectedly … instead of failed"
 */

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock("@/lib/server/notification-bus", () => ({
  notificationBus: { recordSchedulerEvent: vi.fn() },
}));

const jobs = new Map<string, Job>();
const runs = new Map<string, Run[]>();
const appendRun = vi.fn(async (r: Run) => {
  runs.set(r.jobId, [...(runs.get(r.jobId) ?? []), r]);
});
const updateRun = vi.fn(async (r: Run) => {
  runs.set(
    r.jobId,
    (runs.get(r.jobId) ?? []).map((x) => (x.id === r.id ? r : x)),
  );
});
vi.mock("@/lib/server/scheduler-store", () => ({
  appendRun: (r: Run) => appendRun(r),
  updateRun: (r: Run) => updateRun(r),
  listRuns: vi.fn(async (id: string) => [...(runs.get(id) ?? [])].reverse()),
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
  runs.clear();
  query.mockReset();
  appendRun.mockClear();
  updateRun.mockClear();
});
afterEach(() => {
  globalThis.__claudiusScheduler = undefined;
});

describe("fire — a run that didn't start says why", () => {
  test("a missing folder records a skipped run and the job-level reason, without calling the SDK", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job({ cwd: join(tmpdir(), "claudius-gone-2.1.302-xyz") }));
    await s.runNow("j1");
    expect(query).not.toHaveBeenCalled();
    const [r] = runs.get("j1")!;
    expect(r.status).toBe("skipped");
    expect(r.note).toBe(SKIP_FOLDER_MISSING);
    expect(jobs.get("j1")!.lastSkipReason).toBe(SKIP_FOLDER_MISSING);
    expect(typeof jobs.get("j1")!.lastSkipAt).toBe("number");
    expect(activeSkip(jobs.get("j1")!)?.text).toBe("The job's folder no longer exists.");
  });

  test("a run that starts clears the earlier skip reason", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job({ lastSkipReason: SKIP_PREVIOUS_RUN, lastSkipAt: 5 }));
    query.mockReturnValue(stream({ type: "result", subtype: "success", total_cost_usd: 0.01 }));
    await s.runNow("j1");
    const stored = jobs.get("j1")!;
    expect(stored.lastSkipReason).toBeUndefined();
    expect(stored.lastSkipAt).toBeUndefined();
    expect(stored.lastStatus).toBe("success");
    expect(activeSkip(stored)).toBeNull();
  });
});

describe("fire — a run that died is failed, not Completed", () => {
  test("a stream that ends without a result message is recorded as an error", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job());
    query.mockReturnValue(stream({ type: "system", subtype: "init" }));
    await s.runNow("j1");
    const finished = runs.get("j1")!.at(-1)!;
    expect(finished.status).toBe("error");
    expect(finished.note).toBe(RUN_ENDED_WITHOUT_RESULT);
    expect(jobs.get("j1")!.lastStatus).toBe("error");
  });

  test("a stream with a success result stays a success", async () => {
    const s = await freshScheduler();
    jobs.set("j1", job());
    query.mockReturnValue(stream({ type: "result", subtype: "success" }));
    await s.runNow("j1");
    expect(runs.get("j1")!.at(-1)!.status).toBe("success");
  });
});

describe("boot — runs left 'running' by an earlier process", () => {
  test("are marked failed (interrupted) and the job's lastStatus follows", async () => {
    const old = Date.now() - Math.round(process.uptime() * 1000) - 60_000;
    jobs.set("j1", job({ lastRunAt: old, lastStatus: "running" }));
    runs.set("j1", [{ id: "r-old", jobId: "j1", startedAt: old, status: "running" }]);
    const s = await freshScheduler();
    await s.boot();
    const r = runs.get("j1")![0];
    expect(r.status).toBe("error");
    expect(r.note).toBe(RUN_INTERRUPTED);
    // The real end time is unknown — don't stamp the boot time as the end.
    expect(r.endedAt).toBeUndefined();
    expect(jobs.get("j1")!.lastStatus).toBe("error");
  });

  test("a run started by this process (e.g. before a dev hot reload) is left alone", async () => {
    const recent = Date.now();
    jobs.set("j1", job({ lastRunAt: recent, lastStatus: "running" }));
    runs.set("j1", [{ id: "r-new", jobId: "j1", startedAt: recent, status: "running" }]);
    const s = await freshScheduler();
    await s.boot();
    expect(runs.get("j1")![0].status).toBe("running");
    expect(jobs.get("j1")!.lastStatus).toBe("running");
    expect(updateRun).not.toHaveBeenCalled();
  });
});

describe("activeSkip / runNoteText", () => {
  test("a skip older than the latest started run is not shown", () => {
    expect(activeSkip({ lastSkipReason: SKIP_PREVIOUS_RUN, lastSkipAt: 10, lastRunAt: 20 })).toBeNull();
    expect(activeSkip({ lastSkipReason: SKIP_PREVIOUS_RUN, lastSkipAt: 30, lastRunAt: 20 })?.reason).toBe(
      SKIP_PREVIOUS_RUN,
    );
    expect(activeSkip({ lastSkipReason: SKIP_PREVIOUS_RUN })).toBeNull();
    expect(activeSkip({})).toBeNull();
  });

  test("known notes read as sentences; unknown notes pass through", () => {
    expect(runNoteText(SKIP_PREVIOUS_RUN)).toBe("The previous run was still in progress.");
    expect(runNoteText(RUN_INTERRUPTED)).toMatch(/Claudius stopped/);
    expect(runNoteText("error_max_turns")).toBe("error_max_turns");
  });
});
