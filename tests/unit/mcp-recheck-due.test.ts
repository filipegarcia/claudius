import { describe, expect, test } from "vitest";
import { mcpRecheckDue } from "@/lib/server/session";

describe("mcpRecheckDue (CC 2.1.273/2.1.288 — B9)", () => {
  test("not due before the interval elapses", () => {
    const now = 1_000_000;
    expect(mcpRecheckDue(now, now)).toBe(false); // just ran
    expect(mcpRecheckDue(now, now - 29_999)).toBe(false);
  });

  test("due once the interval has elapsed", () => {
    const now = 1_000_000;
    expect(mcpRecheckDue(now, now - 30_000)).toBe(true);
    expect(mcpRecheckDue(now, now - 120_000)).toBe(true);
  });

  test("first check (lastAt=0) is always due", () => {
    expect(mcpRecheckDue(30_000, 0)).toBe(true);
  });

  test("honours a custom interval", () => {
    expect(mcpRecheckDue(5_000, 0, 10_000)).toBe(false);
    expect(mcpRecheckDue(10_000, 0, 10_000)).toBe(true);
  });
});
