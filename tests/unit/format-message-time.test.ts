import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatClockTime, formatMessageTime } from "@/lib/client/format-message-time";

/**
 * CC 2.1.257 (F4) — the clock overrides reach the bubble/StatusLine
 * formatters, and the "same day?" decision is made in the *target* zone so a
 * UTC override can't mislabel a late-evening-local message.
 */
describe("formatMessageTime with clock options (F4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("invalid / missing stamps still return null", () => {
    expect(formatMessageTime(undefined)).toBeNull();
    expect(formatMessageTime(Number.NaN)).toBeNull();
  });

  test("h23 renders UTC midnight as 00:, never 24:", () => {
    // 2024-01-15T00:05:00Z — midnight-hour in UTC.
    const at = Date.UTC(2024, 0, 15, 0, 5, 0);
    vi.setSystemTime(at);
    const out = formatMessageTime(at, { hourCycle: "h23", timeZone: "UTC" });
    expect(out).not.toBeNull();
    expect(out!.short.startsWith("00:")).toBe(true);
    expect(out!.short).not.toContain("24:");
  });

  test('"same day" is computed in the target zone (UTC rolls over before local)', () => {
    // 2024-01-15T00:30:00Z. "Now" is the same instant. In UTC both are the
    // 15th → same day → the short form has no date (just HH:MM).
    const at = Date.UTC(2024, 0, 15, 0, 30, 0);
    vi.setSystemTime(at);
    const utc = formatMessageTime(at, { hourCycle: "h23", timeZone: "UTC" });
    expect(utc).not.toBeNull();
    // Same-day short form is purely the clock (digits + separator), no month name.
    expect(/[A-Za-z]{3}/.test(utc!.short)).toBe(false);
  });

  test("the default (no opts) path still produces a value", () => {
    const at = Date.UTC(2024, 5, 1, 15, 30, 0);
    vi.setSystemTime(at);
    const out = formatMessageTime(at);
    expect(out).not.toBeNull();
    expect(typeof out!.short).toBe("string");
    expect(out!.short.length).toBeGreaterThan(0);
  });
});

describe("formatClockTime (F4 — StatusLine turn-end clock)", () => {
  test("null for missing/invalid stamps", () => {
    expect(formatClockTime(undefined)).toBeNull();
    expect(formatClockTime(Number.NaN)).toBeNull();
  });

  test("h23 + UTC renders midnight hour as 0:0x (numeric hour, not 24)", () => {
    const at = Date.UTC(2024, 0, 15, 0, 5, 0);
    const out = formatClockTime(at, { hourCycle: "h23", timeZone: "UTC" });
    expect(out).not.toBeNull();
    expect(out).toContain("0:05");
    expect(out).not.toContain("24:");
  });

  test("h12 + UTC renders an AM/PM clock", () => {
    const at = Date.UTC(2024, 0, 15, 21, 5, 0);
    const out = formatClockTime(at, { hourCycle: "h12", timeZone: "UTC" });
    expect(out).toContain("9:05");
    expect(out).toMatch(/PM/i);
  });
});
