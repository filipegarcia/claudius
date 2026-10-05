import { describe, expect, test } from "vitest";
import { isContextWindowExceeded } from "@/lib/shared/context-overflow";

/**
 * CC 2.1.216 (F6) — the `/context` over-window boundary, shared by the overlay
 * callout and the in-chat banner so they can't drift.
 */
describe("isContextWindowExceeded (F6)", () => {
  test("strictly over 100% is exceeded", () => {
    expect(isContextWindowExceeded(100.1)).toBe(true);
    expect(isContextWindowExceeded(130)).toBe(true);
  });

  test("exactly 100% (at the limit) is NOT exceeded", () => {
    expect(isContextWindowExceeded(100)).toBe(false);
  });

  test("a near-full 99.5% is NOT exceeded (no pre-rounding)", () => {
    expect(isContextWindowExceeded(99.5)).toBe(false);
  });

  test("under the window is not exceeded", () => {
    expect(isContextWindowExceeded(0)).toBe(false);
    expect(isContextWindowExceeded(42)).toBe(false);
  });

  test("non-finite values are never exceeded", () => {
    expect(isContextWindowExceeded(Number.NaN)).toBe(false);
    expect(isContextWindowExceeded(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
