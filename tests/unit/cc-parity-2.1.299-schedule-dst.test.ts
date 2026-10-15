// Must run before anything reads the local zone: the scheduler resolves cron
// in the server's local timezone (no `tz` option), so the integration half of
// this file pins it. Vitest's default `forks` pool gives each file its own
// process, so this doesn't leak into other files.
process.env.TZ = "America/New_York";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CronExpressionParser } from "cron-parser";
import { nextFireAfter, nextFireMs, FIRE_ANCHOR_MAX_AGE_MS } from "@/lib/shared/cron";
import type { Job } from "@/lib/server/scheduler-store";

/**
 * CC 2.1.299 parity — "Fixed scheduled tasks and loops firing again after
 * every turn, or firing early, during the repeated hour when daylight saving
 * time ends". 2026-11-01 in America/New_York: 01:00–01:59 happens twice,
 * first as EDT (05:00Z–05:59Z) then as EST (06:00Z–06:59Z).
 */
const TZ = "America/New_York";
const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

// The `30 1 * * *` job fired at 01:30 EDT; the run started 300ms late.
const LAST_FIRE = ms("2026-11-01T05:30:00.300Z");
// Re-armed after the run — now 01:15 EST, before the repeated 01:30.
const REARM_AT = ms("2026-11-01T06:15:00Z");

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("@/lib/server/notification-bus", () => ({
  notificationBus: { recordSchedulerEvent: vi.fn() },
}));

const store = new Map<string, Job>();
vi.mock("@/lib/server/scheduler-store", () => ({
  appendRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => []),
  saveJob: vi.fn(),
  listJobs: vi.fn(async () => [...store.values()]),
  getJob: vi.fn(async (id: string) => store.get(id) ?? null),
  patchJob: vi.fn(async (id: string, patch: Partial<Job>) => {
    const cur = store.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    store.set(id, next);
    return next;
  }),
}));

describe("nextFireAfter — a stalled cron-parser iterator", () => {
  test("stops stepping when the iterator stops advancing (Australia/Lord_Howe 30-min shift)", () => {
    // Around Lord Howe's fall-back, cron-parser's iterator for `0 * * * *`
    // returns the same slot on every (slow) call. Mocked: the real calls take
    // hundreds of ms each, so spinning to the step cap took ~20 minutes.
    const stuck = ms("2026-04-04T14:00:00Z");
    const next = vi.fn(() => new Date(stuck));
    const spy = vi
      .spyOn(CronExpressionParser, "parse")
      .mockImplementationOnce(() => ({ next }) as unknown as ReturnType<typeof CronExpressionParser.parse>);
    try {
      const now = ms("2026-04-04T14:10:00Z");
      const got = nextFireAfter("0 * * * *", ms("2026-04-04T13:00:00.200Z"), now, "Australia/Lord_Howe");
      expect(next.mock.calls.length).toBeGreaterThan(0);
      expect(next.mock.calls.length).toBeLessThanOrEqual(2);
      expect(got).toBe(nextFireMs("0 * * * *", new Date(now)));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("nextFireAfter — DST fall-back (explicit tz)", () => {
  test("reproduces the bug: computing from now re-fires the repeated 01:30", () => {
    // Guard: this is what `nextFireMs(cron)` did on re-arm — 01:30 EST.
    expect(iso(nextFireAfter("30 1 * * *", undefined, REARM_AT, TZ))).toBe("2026-11-01T06:30:00.000Z");
  });

  test("a fixed wall-clock schedule fires once in the repeated hour", () => {
    for (const now of [ms("2026-11-01T05:31:00Z"), ms("2026-11-01T06:10:00Z"), REARM_AT, ms("2026-11-01T06:29:59Z")]) {
      expect(iso(nextFireAfter("30 1 * * *", LAST_FIRE, now, TZ))).toBe("2026-11-02T06:30:00.000Z");
    }
  });

  test("a fixed-hour multi-slot schedule doesn't repeat the hour either", () => {
    const last = ms("2026-11-01T05:30:00.100Z"); // */30 1 → 01:30 EDT
    expect(iso(nextFireAfter("*/30 1 * * *", last, ms("2026-11-01T06:05:00Z"), TZ))).toBe(
      "2026-11-02T06:00:00.000Z",
    );
  });

  test("wildcard-hour schedules keep firing on elapsed time through both copies", () => {
    // Hourly: 01:00 EDT fired → 01:00 EST is an hour later, not early.
    expect(iso(nextFireAfter("0 * * * *", ms("2026-11-01T05:00:00.200Z"), ms("2026-11-01T05:01:00Z"), TZ))).toBe(
      "2026-11-01T06:00:00.000Z",
    );
    // */15 inside the second copy: 01:45 EDT → 01:00 EST → 01:15 EST …
    expect(iso(nextFireAfter("*/15 * * * *", ms("2026-11-01T05:45:00.200Z"), ms("2026-11-01T05:46:00Z"), TZ))).toBe(
      "2026-11-01T06:00:00.000Z",
    );
    expect(iso(nextFireAfter("*/15 * * * *", ms("2026-11-01T06:00:00.200Z"), ms("2026-11-01T06:01:00Z"), TZ))).toBe(
      "2026-11-01T06:15:00.000Z",
    );
  });

  test("a run started just ahead of its slot doesn't re-arm onto that slot", () => {
    // The scheduler fires up to 250ms early; a fast run then re-arms before
    // the slot itself has passed.
    const slot = ms("2026-10-20T13:00:00Z");
    expect(iso(nextFireAfter("0 9 * * *", slot - 200, slot - 50, TZ))).toBe("2026-10-21T13:00:00.000Z");
  });

  test("outside a transition it matches computing from now", () => {
    const now = ms("2026-10-20T15:07:00Z");
    for (const cron of ["*/5 * * * *", "0 * * * *", "0 9 * * 1-5", "30 1 * * *"]) {
      expect(nextFireAfter(cron, now - 60 * 60 * 1000, now, TZ)).toBe(
        nextFireAfter(cron, undefined, now, TZ),
      );
    }
  });

  test("stale, future, or missing anchors fall back to now", () => {
    expect(nextFireAfter("30 1 * * *", REARM_AT - FIRE_ANCHOR_MAX_AGE_MS, REARM_AT, TZ)).toBe(
      ms("2026-11-01T06:30:00Z"),
    );
    expect(nextFireAfter("30 1 * * *", REARM_AT + 1, REARM_AT, TZ)).toBe(ms("2026-11-01T06:30:00Z"));
    expect(nextFireAfter("30 1 * * *", Number.NaN, REARM_AT, TZ)).toBe(ms("2026-11-01T06:30:00Z"));
  });

  test("an invalid cron yields null", () => {
    expect(nextFireAfter("not a cron", LAST_FIRE, REARM_AT, TZ)).toBeNull();
  });
});

describe("scheduler.arm — anchors the re-arm on lastRunAt (process TZ)", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers({ now: REARM_AT });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the process TZ really is America/New_York in this worker", () => {
    // 06:15Z is 01:15 EST — if TZ didn't take, the next test proves nothing.
    expect(new Date(REARM_AT).getHours()).toBe(1);
    expect(nextFireMs("30 1 * * *", new Date(REARM_AT))).toBe(ms("2026-11-01T06:30:00Z"));
  });

  test("re-arming in the repeated hour schedules tomorrow, not 01:30 EST", async () => {
    const { scheduler } = await import("@/lib/server/scheduler");
    const job: Job = {
      id: "dst",
      name: "nightly",
      cron: "30 1 * * *",
      prompt: "hi",
      cwd: "/tmp",
      enabled: true,
      createdAt: LAST_FIRE - 1000,
      updatedAt: LAST_FIRE - 1000,
      lastRunAt: LAST_FIRE,
      lastStatus: "success",
    };
    store.set(job.id, job);

    await scheduler.arm(job);
    expect(iso(store.get(job.id)!.nextRunAt ?? null)).toBe("2026-11-02T06:30:00.000Z");
    scheduler.disarm(job.id);
  });
});
