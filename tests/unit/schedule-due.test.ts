import { describe, expect, test } from "vitest";
import { isScheduleDue } from "@/lib/shared/schedule-due";

/**
 * CC 2.1.286 (H11) — a job whose next run is in the past reads "Due".
 */
describe("isScheduleDue (H11)", () => {
  const now = 1_000_000;

  test("past or exactly-now next run is due", () => {
    expect(isScheduleDue(now - 1, now)).toBe(true);
    expect(isScheduleDue(now, now)).toBe(true);
  });

  test("future next run is not due", () => {
    expect(isScheduleDue(now + 1, now)).toBe(false);
  });

  test("absent / non-finite next run is not due", () => {
    expect(isScheduleDue(undefined, now)).toBe(false);
    expect(isScheduleDue(null, now)).toBe(false);
    expect(isScheduleDue(Number.NaN, now)).toBe(false);
  });
});
