import { describe, expect, test } from "vitest";
import {
  EFFORT_WAIT_NOTE,
  NO_EFFORT_WAIT,
  effortApplied,
  effortPicked,
  effortRequestStarted,
  effortToastText,
} from "@/lib/shared/effort-wait-note";

/**
 * CC 2.1.312 — "Improved the prompt's effort indicator: a change made mid-task
 * now says it may wait for your next message, and the note clears when it no
 * longer applies". These are the pure transitions behind the effort pill's
 * note (`lib/client/use-session.ts` → `SessionCard` EffortPill) and the
 * `/effort` toast, which share the `effortPicked` decision.
 */

describe("effortPicked", () => {
  test("off-turn changes never wait: the next request is the next message", () => {
    expect(effortPicked(NO_EFFORT_WAIT, { pending: false, picked: "max", shownBefore: "high" })).toEqual(
      NO_EFFORT_WAIT,
    );
  });

  test("a mid-turn change to a different level waits, remembering the level in force", () => {
    expect(effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" })).toEqual({
      inForce: "high",
      waits: true,
      appliedSeen: false,
    });
  });

  test("re-picking the level already in force is not a wait", () => {
    expect(effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "high", shownBefore: "high" }).waits).toBe(false);
  });

  test("a second change in the same window compares against the original level in force", () => {
    const first = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    // The pill now shows "max", but the running request still uses "high".
    const back = effortPicked(first, { pending: true, picked: "high", shownBefore: "max" });
    expect(back).toMatchObject({ inForce: "high", waits: false });
    const again = effortPicked(first, { pending: true, picked: "low", shownBefore: "max" });
    expect(again).toMatchObject({ inForce: "high", waits: true });
  });

  test("a model that takes no effort parameter never waits", () => {
    expect(
      effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high", noEffortParam: true }),
    ).toEqual(NO_EFFORT_WAIT);
  });
});

describe("effortApplied", () => {
  test("is a no-op when no change is waiting", () => {
    expect(effortApplied(NO_EFFORT_WAIT, "max")).toBe(NO_EFFORT_WAIT);
  });

  test("an 'auto' pick that resolves to the level in force clears the note", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "auto", shownBefore: "high" });
    expect(picked.waits).toBe(true);
    expect(effortApplied(picked, "high")).toEqual(NO_EFFORT_WAIT);
  });

  test("a resolved level that differs keeps the note and marks the pick applied", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "auto", shownBefore: "low" });
    expect(effortApplied(picked, "high")).toEqual({ inForce: "low", waits: true, appliedSeen: true });
  });

  test("a model that takes no effort parameter leaves nothing to wait for", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    expect(effortApplied(picked, null)).toEqual(NO_EFFORT_WAIT);
  });
});

describe("effortRequestStarted", () => {
  test("is a no-op when no change is waiting", () => {
    expect(effortRequestStarted(NO_EFFORT_WAIT)).toBe(NO_EFFORT_WAIT);
  });

  test("a request that started before the server applied the pick keeps the note", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    expect(effortRequestStarted(picked)).toBe(picked);
  });

  test("the first request after the pick was applied carries it: the note clears", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    expect(effortRequestStarted(effortApplied(picked, "max"))).toEqual(NO_EFFORT_WAIT);
  });

  test("a new pick after an applied one waits for its own effort_applied", () => {
    const applied = effortApplied(
      effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" }),
      "max",
    );
    const repicked = effortPicked(applied, { pending: true, picked: "low", shownBefore: "max" });
    expect(repicked.appliedSeen).toBe(false);
    expect(effortRequestStarted(repicked)).toBe(repicked);
  });
});

describe("effortToastText", () => {
  const base = "Effort set to max";

  test("uses Claude Code's wording", () => {
    expect(EFFORT_WAIT_NOTE).toBe("may wait for your next message");
    expect(effortToastText(base, true)).toBe("Effort set to max · may wait for your next message");
    expect(effortToastText(base, false)).toBe(base);
  });

  test("switching back to the level in force while a change waits: toast and pill agree", () => {
    // high in force; /effort low mid-turn, then /effort high.
    const first = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "low", shownBefore: "high" });
    const back = effortPicked(first, { pending: true, picked: "high", shownBefore: "low" });
    expect(back.waits).toBe(false);
    expect(effortToastText("Effort set to high", back.waits)).toBe("Effort set to high");
  });
});
