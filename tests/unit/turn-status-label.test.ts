import { describe, expect, test } from "vitest";
import { DEEP_IN_THOUGHT_THRESHOLD_SEC, workingStatusLabel } from "@/lib/shared/turn-status-label";

/**
 * Claude Code 2.1.271 — "Improved the spinner status during long thinking:
 * it now reads 'deep in thought' after 45s." Pure-function coverage for the
 * `StatusLine` "Working" -> "Deep in thought" label swap.
 */

describe("workingStatusLabel", () => {
  test("reads 'Working' before the threshold", () => {
    expect(workingStatusLabel(0)).toBe("Working");
    expect(workingStatusLabel(44)).toBe("Working");
  });

  test("reads 'Deep in thought' at and after the threshold", () => {
    expect(workingStatusLabel(DEEP_IN_THOUGHT_THRESHOLD_SEC)).toBe("Deep in thought");
    expect(workingStatusLabel(46)).toBe("Deep in thought");
    expect(workingStatusLabel(600)).toBe("Deep in thought");
  });

  test("treats null/undefined (no ticker yet) as 'Working'", () => {
    expect(workingStatusLabel(null)).toBe("Working");
    expect(workingStatusLabel(undefined)).toBe("Working");
  });

  test("threshold constant matches upstream's 45s", () => {
    expect(DEEP_IN_THOUGHT_THRESHOLD_SEC).toBe(45);
  });

  // CC 2.1.271 (C4) — gate "Deep in thought" on no tool running, and add the
  // output-limit resume label.
  test("stays 'Working' past the threshold while a tool is running", () => {
    expect(workingStatusLabel(600, { toolActive: true })).toBe("Working");
    expect(workingStatusLabel(600, { toolActive: false })).toBe("Deep in thought");
  });

  test("reads 'Picking the thought back up' while resuming after the output limit", () => {
    expect(workingStatusLabel(10, { resumingThought: true })).toBe("Picking the thought back up");
    expect(workingStatusLabel(600, { resumingThought: true, toolActive: true })).toBe(
      "Picking the thought back up",
    );
  });
});
