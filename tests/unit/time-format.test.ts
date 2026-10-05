import { describe, expect, test } from "vitest";
import { isValidTimeZone, resolveClockOptions } from "@/lib/shared/time-format";

/**
 * CC 2.1.257 (F4) — `timeFormat` / `timeZone` → Intl clock overrides.
 */
describe("resolveClockOptions (F4)", () => {
  test("the enum formats map to an explicit hourCycle", () => {
    expect(resolveClockOptions("12-hour")).toEqual({ hourCycle: "h12" });
    expect(resolveClockOptions("24-hour")).toEqual({ hourCycle: "h23" });
  });

  test('"24-hour-utc" forces h23 + UTC', () => {
    expect(resolveClockOptions("24-hour-utc")).toEqual({ hourCycle: "h23", timeZone: "UTC" });
  });

  test("auto / unset leave the hour cycle to the locale", () => {
    expect(resolveClockOptions("auto")).toEqual({});
    expect(resolveClockOptions(undefined)).toEqual({});
  });

  test("a strftime pattern falls back to the locale hour cycle but still honors the zone", () => {
    expect(resolveClockOptions("%H:%M")).toEqual({});
    expect(resolveClockOptions("%H:%M", "Europe/Dublin")).toEqual({ timeZone: "Europe/Dublin" });
  });

  test("an explicit valid zone is applied alongside the hour cycle", () => {
    expect(resolveClockOptions("24-hour", "Europe/Dublin")).toEqual({
      hourCycle: "h23",
      timeZone: "Europe/Dublin",
    });
    expect(resolveClockOptions("auto", "America/New_York")).toEqual({
      timeZone: "America/New_York",
    });
  });

  test("24-hour-utc keeps UTC even if a different zone is also set", () => {
    expect(resolveClockOptions("24-hour-utc", "Europe/Dublin")).toEqual({
      hourCycle: "h23",
      timeZone: "UTC",
    });
  });

  test("an invalid / blank zone is dropped (settings.json is hand-editable)", () => {
    expect(resolveClockOptions("auto", "Not/AZone")).toEqual({});
    expect(resolveClockOptions("auto", "   ")).toEqual({});
    expect(resolveClockOptions("24-hour", "garbage")).toEqual({ hourCycle: "h23" });
  });
});

describe("isValidTimeZone (F4)", () => {
  test("accepts real IANA names and UTC", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Dublin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  test("rejects unknown names", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
