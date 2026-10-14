import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.299 — the Cost overlay's `/usage` behaviour warnings and the
 * `/context` skill doctor both read the experimental usage API's `behaviors`
 * slice, which costs a local-transcript scan. `Session` shares one
 * `skipBehaviors: false` call between them (memoized per query), and maps a
 * null section / failure to `null`.
 */
const CWD = "/tmp/fake-session-usage-behaviors-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
  vi.useRealTimers();
});

const USAGE = {
  behaviors: {
    day: { request_count: 10, session_count: 1, behaviors: [{ key: "max_effort", pct: 40, count: 4 }], skills: [] },
    week: {
      request_count: 50,
      session_count: 3,
      behaviors: [{ key: "workflow", pct: 25, count: 12 }],
      skills: [{ name: "pdf", pct: 12 }],
    },
  },
};

function makeSession(usage: (opts: unknown) => Promise<unknown>) {
  const s = new Session({ id: "usage-behaviors-test", cwd: CWD });
  const fn = vi.fn(usage);
  const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: fn };
  (s as unknown as { query: unknown }).query = query;
  return { s, fn, query };
}

describe("Session.getUsageBehaviors", () => {
  test("returns the day/week behaviours from a full (behaviours-scanning) usage call", async () => {
    const { s, fn } = makeSession(async () => USAGE);
    const out = await s.getUsageBehaviors();
    expect(fn).toHaveBeenCalledWith({ skipBehaviors: false });
    expect(out?.day.behaviors).toEqual([{ key: "max_effort", pct: 40, count: 4 }]);
    expect(out?.week.behaviors).toEqual([{ key: "workflow", pct: 25, count: 12 }]);
  });

  test("shares one scan with getWeeklyUsedSkills (and concurrent callers)", async () => {
    const { s, fn } = makeSession(async () => USAGE);
    const [b, skills] = await Promise.all([s.getUsageBehaviors(), s.getWeeklyUsedSkills()]);
    expect(b).not.toBeNull();
    expect(skills).toEqual(["pdf"]);
    await s.getUsageBehaviors();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("the memo expires, and a new query never reuses the old answer", async () => {
    vi.useFakeTimers();
    const { s, fn } = makeSession(async () => USAGE);
    await s.getUsageBehaviors();
    vi.advanceTimersByTime(31_000);
    await s.getUsageBehaviors();
    expect(fn).toHaveBeenCalledTimes(2);

    const fn2 = vi.fn(async () => USAGE);
    (s as unknown as { query: unknown }).query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: fn2 };
    await s.getUsageBehaviors();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  test("null for a non-subscriber (behaviors: null), and failures aren't cached", async () => {
    const { s: nonSub } = makeSession(async () => ({ behaviors: null }));
    expect(await nonSub.getUsageBehaviors()).toBeNull();

    let calls = 0;
    const { s, fn } = makeSession(async () => {
      calls += 1;
      if (calls === 1) throw new Error("scan failed");
      return USAGE;
    });
    expect(await s.getUsageBehaviors()).toBeNull();
    expect(await s.getUsageBehaviors()).not.toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("null with no active query or no experimental API", async () => {
    const s = new Session({ id: "usage-behaviors-noquery", cwd: CWD });
    expect(await s.getUsageBehaviors()).toBeNull();
    (s as unknown as { query: unknown }).query = {};
    expect(await s.getUsageBehaviors()).toBeNull();
  });
});
