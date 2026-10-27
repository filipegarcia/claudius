import { describe, expect, test } from "vitest";
import {
  EFFORT_WAIT_NOTE,
  NO_EFFORT_WAIT,
  effortApplied,
  effortPicked,
  effortToastText,
} from "@/lib/shared/effort-wait-note";

/**
 * CC 2.1.312 — "Improved the prompt's effort indicator: a change made mid-task
 * now says it may wait for your next message, and the note clears when it no
 * longer applies". These are the pure transitions behind the effort pill's
 * note (`lib/client/use-session.ts` → `SessionCard` EffortPill).
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
    });
  });

  test("re-picking the level already in force is not a wait", () => {
    expect(effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "high", shownBefore: "high" })).toEqual({
      inForce: "high",
      waits: false,
    });
  });

  test("a second change in the same window compares against the original level in force", () => {
    const first = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    // The pill now shows "max", but the running request still uses "high".
    const back = effortPicked(first, { pending: true, picked: "high", shownBefore: "max" });
    expect(back).toEqual({ inForce: "high", waits: false });
    const again = effortPicked(first, { pending: true, picked: "low", shownBefore: "max" });
    expect(again).toEqual({ inForce: "high", waits: true });
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

  test("a resolved level that differs keeps the note", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "auto", shownBefore: "low" });
    expect(effortApplied(picked, "high")).toEqual({ inForce: "low", waits: true });
  });

  test("a model that takes no effort parameter leaves nothing to wait for", () => {
    const picked = effortPicked(NO_EFFORT_WAIT, { pending: true, picked: "max", shownBefore: "high" });
    expect(effortApplied(picked, null)).toEqual(NO_EFFORT_WAIT);
  });
});

describe("effortToastText", () => {
  const base = "Effort set to max";

  test("uses Claude Code's wording", () => {
    expect(EFFORT_WAIT_NOTE).toBe("may wait for your next message");
  });

  test("adds the note for a mid-turn change", () => {
    expect(effortToastText(base, { pending: true, picked: "max", shown: "high" })).toBe(
      "Effort set to max · may wait for your next message",
    );
  });

  test("no note when idle, for an unchanged level, or for a model without effort", () => {
    expect(effortToastText(base, { pending: false, picked: "max", shown: "high" })).toBe(base);
    expect(effortToastText(base, { pending: true, picked: "max", shown: "max" })).toBe(base);
    expect(effortToastText(base, { pending: true, picked: "max", shown: null })).toBe(base);
  });
});
