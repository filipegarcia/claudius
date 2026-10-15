import { describe, expect, test } from "vitest";
import { readCronNextFireAt } from "@/lib/shared/session-loops";

/** SDK 0.3.299 — `CronCreateOutput.nextFireAt` (epoch ms), read defensively. */
describe("readCronNextFireAt", () => {
  test("accepts a finite positive epoch-ms number", () => {
    expect(readCronNextFireAt({ id: "x", nextFireAt: 1_790_000_000_000 })).toBe(1_790_000_000_000);
  });

  test("returns undefined when absent (older SDK) or malformed", () => {
    expect(readCronNextFireAt(undefined)).toBeUndefined();
    expect(readCronNextFireAt(null)).toBeUndefined();
    expect(readCronNextFireAt("nope")).toBeUndefined();
    expect(readCronNextFireAt({})).toBeUndefined();
    expect(readCronNextFireAt({ nextFireAt: "123" })).toBeUndefined();
    expect(readCronNextFireAt({ nextFireAt: Number.NaN })).toBeUndefined();
    expect(readCronNextFireAt({ nextFireAt: 0 })).toBeUndefined();
    expect(readCronNextFireAt({ nextFireAt: -5 })).toBeUndefined();
  });
});
