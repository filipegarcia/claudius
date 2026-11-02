import { describe, expect, test } from "vitest";

import {
  GIT_POLL_MAX_MS,
  GIT_POLL_SLOW_FACTOR,
  createCoalescedRunner,
  nextGitPollDelayMs,
} from "@/lib/client/git-poll";

/**
 * CC 2.1.316 — "Improved /diff on large repositories: each refresh usually
 * runs one fewer full-repository git command, and refreshes are spaced out
 * when git is slow". Claudius's Git page and `/diff` overlay now wait for a
 * running `git status` instead of aborting it, and space the next refresh by
 * how long the last one took.
 */

describe("nextGitPollDelayMs", () => {
  test("a fast git keeps the normal poll interval", () => {
    expect(nextGitPollDelayMs(4000, 120)).toBe(4000);
    expect(nextGitPollDelayMs(4000, null)).toBe(4000);
    expect(nextGitPollDelayMs(4000, undefined)).toBe(4000);
  });

  test("a slow git stretches the gap to SLOW_FACTOR × its duration", () => {
    expect(GIT_POLL_SLOW_FACTOR).toBe(3);
    expect(nextGitPollDelayMs(4000, 5000)).toBe(15_000);
    expect(nextGitPollDelayMs(0, 200)).toBe(600);
  });

  test("the gap is capped", () => {
    expect(nextGitPollDelayMs(4000, 120_000)).toBe(GIT_POLL_MAX_MS);
    expect(nextGitPollDelayMs(90_000, 0)).toBe(GIT_POLL_MAX_MS);
  });

  test("NaN / negative inputs count as 0", () => {
    expect(nextGitPollDelayMs(4000, Number.NaN)).toBe(4000);
    expect(nextGitPollDelayMs(4000, -5000)).toBe(4000);
    expect(nextGitPollDelayMs(Number.NaN, Number.NaN)).toBe(0);
    expect(nextGitPollDelayMs(-1, -1)).toBe(0);
  });
});

/** Manual clock + timer queue so the runner's spacing is observable. */
function fakeTimers() {
  let t = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (h: unknown) => {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    advance: (ms: number) => {
      t += ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const due = queue[0];
        if (!due || due.at > t) break;
        queue.shift();
        due.fn();
      }
    },
    pending: () => queue.map((q) => q.at),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createCoalescedRunner", () => {
  test("requests during a run never abort it and queue exactly one spaced follow-up", async () => {
    const timers = fakeTimers();
    const runs: { signal: AbortSignal; resolve: () => void }[] = [];
    const runner = createCoalescedRunner(
      (signal) => new Promise<void>((resolve) => runs.push({ signal, resolve })),
      timers,
    );
    expect(runs).toHaveLength(1);

    runner.request();
    runner.request();
    runner.request();
    expect(runs).toHaveLength(1);
    expect(runs[0].signal.aborted).toBe(false);

    // The running fetch takes 2s; the follow-up waits 3× that.
    timers.advance(2000);
    runs[0].resolve();
    await flush();
    expect(timers.pending()).toEqual([2000 + 6000]);
    timers.advance(5999);
    expect(runs).toHaveLength(1);
    timers.advance(1);
    expect(runs).toHaveLength(2);
    expect(runs[0].signal.aborted).toBe(false);

    // No further request → no further run once it settles.
    runs[1].resolve();
    await flush();
    expect(timers.pending()).toEqual([]);
    runner.dispose();
  });

  test("an idle runner starts a request immediately; a failed run still settles", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const runner = createCoalescedRunner(() => {
      calls++;
      return Promise.reject(new Error("boom"));
    }, timers);
    await flush();
    runner.request();
    expect(calls).toBe(2);
    runner.dispose();
  });

  test("dispose aborts the in-flight run and drops the queued follow-up", async () => {
    const timers = fakeTimers();
    const signals: AbortSignal[] = [];
    let resolveFirst = () => {};
    const runner = createCoalescedRunner(
      (signal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          resolveFirst = resolve;
        }),
      timers,
    );
    runner.request();
    runner.dispose();
    expect(signals[0].aborted).toBe(true);
    resolveFirst();
    await flush();
    expect(timers.pending()).toEqual([]);
    runner.request();
    expect(signals).toHaveLength(1);
  });
});
