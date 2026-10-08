import { describe, expect, test } from "vitest";
import {
  ciVerdict,
  idleLimitMs,
  liveBackgroundTasks,
  parseCiChecks,
  watchCiWith,
  type CiWatchDeps,
} from "../../scripts/sdk-update/orchestrate";

/**
 * PR #295: `gh pr checks --watch` ran two seconds after the PR opened, printed
 * "no checks reported" and exited non-zero; the orchestrator took that as red
 * and spent a 70-minute fix session on a healthy PR. And the SDK half was
 * killed by the 15-minute idle watchdog while it waited on its own e2e run.
 */

describe("ciVerdict", () => {
  test("no checks yet is not a failure", () => {
    expect(ciVerdict([])).toBe("none");
  });
  test("any fail or cancel is red; any pending waits; otherwise green", () => {
    expect(ciVerdict([{ bucket: "pass" }, { bucket: "fail" }])).toBe("fail");
    expect(ciVerdict([{ bucket: "pass" }, { bucket: "cancel" }])).toBe("fail");
    expect(ciVerdict([{ bucket: "pass" }, { bucket: "pending" }])).toBe("pending");
    expect(ciVerdict([{ bucket: "pass" }, { bucket: "skipping" }])).toBe("pass");
  });
});

describe("parseCiChecks", () => {
  test("reads the JSON whatever gh's exit code (1 = failing, 8 = pending)", () => {
    expect(parseCiChecks('[{"name":"e2e","bucket":"fail"}]', "", 1)).toEqual({
      rows: [{ name: "e2e", bucket: "fail" }],
    });
    expect(parseCiChecks('[{"name":"e2e","bucket":"pending"}]\n', "", 8)).toEqual({
      rows: [{ name: "e2e", bucket: "pending" }],
    });
  });
  test('"no checks reported" means none yet, not an error', () => {
    expect(parseCiChecks("", "no checks reported on the 'sdk-update/0.3.294' branch", 1)).toEqual({ rows: [] });
  });
  test("anything else is an error to retry", () => {
    expect(parseCiChecks("", "HTTP 403: API rate limit exceeded", 1)).toEqual({
      error: "HTTP 403: API rate limit exceeded",
    });
  });
});

function fakeDeps(script: Array<ReturnType<CiWatchDeps["readChecks"]>>) {
  let clock = 0;
  let reads = 0;
  const watches: number[] = [];
  const deps: CiWatchDeps = {
    readChecks: () => script[Math.min(reads++, script.length - 1)],
    waitForChecks: () => {
      watches.push(clock);
      clock += 5 * 60_000; // a watch that blocks for a while
    },
    sleep: (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  };
  return { deps, watches, reads: () => reads };
}

describe("watchCiWith", () => {
  test("waits for checks to register instead of calling the PR red (the #295 race)", () => {
    const { deps } = fakeDeps([
      { rows: [] },
      { rows: [] },
      { rows: [{ bucket: "pending" }] },
      { rows: [{ bucket: "pass" }, { bucket: "pass" }] },
    ]);
    expect(watchCiWith(deps)).toEqual({ passed: true, verdict: "pass" });
  });

  test("a rate-limited read is retried, not treated as red", () => {
    const { deps } = fakeDeps([{ error: "API rate limit exceeded" }, { rows: [{ bucket: "pass" }] }]);
    expect(watchCiWith(deps)).toEqual({ passed: true, verdict: "pass" });
  });

  test("a real failure is reported as a confirmed red", () => {
    const { deps } = fakeDeps([{ rows: [{ bucket: "pending" }] }, { rows: [{ bucket: "fail" }] }]);
    expect(watchCiWith(deps)).toEqual({ passed: false, verdict: "fail" });
  });

  test("no checks after the registration window is unverified, not red", () => {
    const { deps } = fakeDeps([{ rows: [] }]);
    expect(watchCiWith(deps)).toEqual({ passed: false, verdict: "none" });
  });

  test("a watch that returns at once doesn't spin", () => {
    const { deps, reads } = fakeDeps([{ rows: [{ bucket: "pending" }] }]);
    deps.waitForChecks = () => {}; // gh --watch erroring instantly
    const result = watchCiWith(deps);
    expect(result.passed).toBe(false);
    // 120 min budget at >= 30 s per lap → at most ~240 reads, not thousands
    expect(reads()).toBeLessThanOrEqual(241);
  });
});

describe("idle watchdog and background tasks", () => {
  test("background_tasks_changed counts live, non-ambient tasks", () => {
    const msg = (tasks: Array<{ ambient?: boolean }>) => ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map((t, i) => ({ task_id: `t${i}`, task_type: "local_bash", description: "e2e", ...t })),
    });
    expect(liveBackgroundTasks(msg([{}, { ambient: true }]))).toBe(1);
    expect(liveBackgroundTasks(msg([]))).toBe(0);
    expect(liveBackgroundTasks({ type: "system", subtype: "task_started" })).toBeNull();
    expect(liveBackgroundTasks({ type: "assistant" })).toBeNull();
  });

  test("the limit is 15 min normally and 60 min while a background task runs", () => {
    expect(idleLimitMs(0)).toBe(15 * 60_000);
    expect(idleLimitMs(1)).toBe(60 * 60_000);
  });
});
