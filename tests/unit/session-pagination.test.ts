import { describe, expect, test } from "vitest";
import { hasMoreSessions, SESSION_PAGE_SIZE } from "@/lib/shared/session-pagination";

/**
 * CC 2.1.243 (H9) — "load more" gating for the session list.
 */
describe("hasMoreSessions (H9)", () => {
  test("a full page back means more may exist", () => {
    expect(hasMoreSessions(200, 200)).toBe(true);
    expect(hasMoreSessions(SESSION_PAGE_SIZE, SESSION_PAGE_SIZE)).toBe(true);
    // Defensive: more than requested (shouldn't happen) still counts as more.
    expect(hasMoreSessions(205, 200)).toBe(true);
  });

  test("a partial page means we've reached the end", () => {
    expect(hasMoreSessions(37, 200)).toBe(false);
    expect(hasMoreSessions(0, 200)).toBe(false);
  });

  test("a non-positive limit is never 'more'", () => {
    expect(hasMoreSessions(0, 0)).toBe(false);
  });
});
