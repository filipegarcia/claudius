import { describe, expect, test } from "vitest";
import { LIMIT_RESET_NOTICE, limitHasReset } from "@/lib/client/rate-limit-cta";
import { classifyInformationalLevel } from "@/lib/shared/system-informational";

/**
 * CC 2.1.326 parity:
 *  - "Fixed an upgrade hint appearing under an old usage limit message after
 *    the limit had reset" → `limitHasReset` gates the limit panels' CTA rows.
 *  - "a hook that stops Claude is yellow, and the reason is shown under them"
 *    → a `prevent_continuation` informational line is always shown, amber.
 */
describe("limitHasReset (CC 2.1.326)", () => {
  const nowMs = Date.UTC(2026, 10, 16, 12, 0, 0);
  const nowSec = nowMs / 1000;

  test("a reset time in the future has not reset", () => {
    expect(limitHasReset(nowSec + 1, nowMs)).toBe(false);
    expect(limitHasReset(nowSec + 3600, nowMs)).toBe(false);
  });

  test("a reset time at or before now has reset", () => {
    expect(limitHasReset(nowSec, nowMs)).toBe(true);
    expect(limitHasReset(nowSec - 60, nowMs)).toBe(true);
  });

  test("matches the countdown's whole-second boundary (<1s left reads as reset)", () => {
    expect(limitHasReset(nowSec + 0.5, nowMs)).toBe(true);
  });

  test("an unknown reset never counts as reset", () => {
    expect(limitHasReset(undefined, nowMs)).toBe(false);
    expect(limitHasReset(null, nowMs)).toBe(false);
    expect(limitHasReset(0, nowMs)).toBe(false);
    expect(limitHasReset(Number.NaN, nowMs)).toBe(false);
  });

  test("the reset notice copy", () => {
    expect(LIMIT_RESET_NOTICE).toBe("This limit has reset.");
  });
});

describe("classifyInformationalLevel with prevent_continuation (CC 2.1.326)", () => {
  test("a line that stops Claude is shown with the warning tone at any level", () => {
    for (const level of ["notice", "suggestion", "warning", undefined, "future-level"]) {
      expect(classifyInformationalLevel(level, true)).toEqual({ hidden: false, infoLevel: "warning" });
    }
  });

  test("even a transcript-only 'info' line is shown when it stopped Claude", () => {
    expect(classifyInformationalLevel("info", true)).toEqual({ hidden: false, infoLevel: "warning" });
  });

  test("without prevent_continuation the level-only classification is unchanged", () => {
    expect(classifyInformationalLevel("info", false)).toEqual({ hidden: true });
    expect(classifyInformationalLevel("notice", false)).toEqual({ hidden: false, infoLevel: "notice" });
    expect(classifyInformationalLevel("notice")).toEqual({ hidden: false, infoLevel: "notice" });
    expect(classifyInformationalLevel(undefined)).toEqual({ hidden: false });
  });
});
