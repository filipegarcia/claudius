import { describe, expect, test } from "vitest";
import { shouldForceReducedMotion } from "@/lib/shared/reduced-motion";

/**
 * CC 2.1.287 (F9) — the `prefersReducedMotion` setting forces reduced motion
 * only when explicitly true (the OS media query applies independently).
 */
describe("shouldForceReducedMotion (F9)", () => {
  test("true forces it", () => {
    expect(shouldForceReducedMotion(true)).toBe(true);
  });

  test("false / unset do not force it", () => {
    expect(shouldForceReducedMotion(false)).toBe(false);
    expect(shouldForceReducedMotion(undefined)).toBe(false);
    expect(shouldForceReducedMotion(null)).toBe(false);
  });

  test("stray non-booleans from a hand-edited file do not force it", () => {
    expect(shouldForceReducedMotion("true")).toBe(false);
    expect(shouldForceReducedMotion(1)).toBe(false);
  });
});
