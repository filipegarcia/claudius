import { describe, expect, test } from "vitest";
import {
  TOKEN_EXPIRY_WARNING_WINDOW_MS,
  shouldWarnTokenExpiring,
} from "@/lib/server/token-expiry";

describe("shouldWarnTokenExpiring", () => {
  const now = 1_700_000_000_000;

  test("warns when the expiry falls inside the warning window", () => {
    expect(shouldWarnTokenExpiring(now + 60_000, now)).toBe(true);
    expect(shouldWarnTokenExpiring(now + TOKEN_EXPIRY_WARNING_WINDOW_MS, now)).toBe(true);
  });

  test("does not warn when the expiry is further out than the window", () => {
    expect(shouldWarnTokenExpiring(now + TOKEN_EXPIRY_WARNING_WINDOW_MS + 1, now)).toBe(false);
    expect(shouldWarnTokenExpiring(now + 30 * 24 * 60 * 60 * 1000, now)).toBe(false);
  });

  test("does not warn once the token has already expired (that's auth-failed-detector's job)", () => {
    expect(shouldWarnTokenExpiring(now - 1, now)).toBe(false);
    expect(shouldWarnTokenExpiring(now, now)).toBe(false);
  });

  test("does not warn when there's no known expiry", () => {
    expect(shouldWarnTokenExpiring(undefined, now)).toBe(false);
    expect(shouldWarnTokenExpiring(null, now)).toBe(false);
    expect(shouldWarnTokenExpiring(Number.NaN, now)).toBe(false);
  });
});
