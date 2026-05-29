import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearSessionGoal,
  getSessionGoal,
  setGoalAchieved,
  setSessionGoal,
} from "@/lib/server/sessions-db";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Unit coverage for the per-session goal accessors backing the `/goal`
 * feature. Exercises the persistence path the e2e can't reach (it drives
 * achievement via dev-broadcast, which never touches the DB), pinning down:
 *
 *   - migration 010's columns exist and round-trip,
 *   - achievement is sticky and carries the summary,
 *   - replacing a goal RESETS achievement (a new objective isn't met yet),
 *   - clearing wipes everything,
 *   - achieving with no goal set is a no-op.
 *
 * Works against a real temp $HOME so `openDb` lays out the per-cwd
 * `.claudius.db` and runs migrations exactly where production expects.
 */

let tmp: TmpHome;
const CWD = "/tmp/fake-claudius-goal-workspace";

beforeEach(async () => {
  tmp = makeTempHome();
  // Open (and migrate) the DB up front so the `sessions` table + goal
  // columns exist before the first write.
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("session goal accessors", () => {
  test("unset goal reads as empty", async () => {
    const g = await getSessionGoal(CWD, "sess-1");
    expect(g.goal).toBeNull();
    expect(g.achieved).toBe(false);
    expect(g.summary).toBeNull();
  });

  test("set then get round-trips the text (un-achieved)", async () => {
    const set = await setSessionGoal(CWD, "sess-1", "Ship the goal feature");
    expect(set.goal).toBe("Ship the goal feature");
    expect(set.achieved).toBe(false);
    expect(typeof set.setAt).toBe("number");

    const read = await getSessionGoal(CWD, "sess-1");
    expect(read.goal).toBe("Ship the goal feature");
    expect(read.achieved).toBe(false);
  });

  test("set trims whitespace; empty/whitespace clears the goal", async () => {
    const set = await setSessionGoal(CWD, "sess-1", "  trim me  ");
    expect(set.goal).toBe("trim me");

    const cleared = await setSessionGoal(CWD, "sess-1", "   ");
    expect(cleared.goal).toBeNull();
    expect((await getSessionGoal(CWD, "sess-1")).goal).toBeNull();
  });

  test("achievement is sticky and records the summary", async () => {
    await setSessionGoal(CWD, "sess-1", "Refactor the auth module");
    const achieved = await setGoalAchieved(CWD, "sess-1", "Auth module refactored and tested.");
    expect(achieved.achieved).toBe(true);
    expect(achieved.summary).toBe("Auth module refactored and tested.");
    expect(typeof achieved.achievedAt).toBe("number");

    // Sticky across a fresh read.
    const read = await getSessionGoal(CWD, "sess-1");
    expect(read.achieved).toBe(true);
    expect(read.summary).toBe("Auth module refactored and tested.");
    expect(read.goal).toBe("Refactor the auth module");
  });

  test("replacing a goal resets achievement", async () => {
    await setSessionGoal(CWD, "sess-1", "First goal");
    await setGoalAchieved(CWD, "sess-1", "Done.");
    expect((await getSessionGoal(CWD, "sess-1")).achieved).toBe(true);

    const replaced = await setSessionGoal(CWD, "sess-1", "Second goal");
    expect(replaced.goal).toBe("Second goal");
    expect(replaced.achieved).toBe(false);
    expect(replaced.summary).toBeNull();
    expect(replaced.achievedAt).toBeNull();

    const read = await getSessionGoal(CWD, "sess-1");
    expect(read.achieved).toBe(false);
  });

  test("clearing wipes goal and achievement", async () => {
    await setSessionGoal(CWD, "sess-1", "A goal");
    await setGoalAchieved(CWD, "sess-1", "Met.");
    const cleared = await clearSessionGoal(CWD, "sess-1");
    expect(cleared.goal).toBeNull();
    expect(cleared.achieved).toBe(false);
    expect((await getSessionGoal(CWD, "sess-1")).goal).toBeNull();
  });

  test("achieving with no goal set is a no-op", async () => {
    const r = await setGoalAchieved(CWD, "sess-none", "nothing to achieve");
    expect(r.goal).toBeNull();
    expect(r.achieved).toBe(false);
  });

  test("goals are isolated per session id", async () => {
    await setSessionGoal(CWD, "sess-a", "Goal A");
    await setSessionGoal(CWD, "sess-b", "Goal B");
    expect((await getSessionGoal(CWD, "sess-a")).goal).toBe("Goal A");
    expect((await getSessionGoal(CWD, "sess-b")).goal).toBe("Goal B");
  });
});
