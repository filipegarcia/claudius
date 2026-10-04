import { describe, expect, test } from "vitest";
import { autoContinueNotice } from "@/lib/client/auto-continue";

/**
 * CC 2.1.234 (E11) — the usage-limit panel shows "Continuing automatically at
 * HH:MM" only when the setting is on AND we know the reset time.
 */
describe("autoContinueNotice (E11)", () => {
  test("shows the line when enabled and a reset time is known", () => {
    expect(autoContinueNotice(true, "3:00 PM")).toBe("Continuing automatically at 3:00 PM");
  });

  test("no line when the setting is off", () => {
    expect(autoContinueNotice(false, "3:00 PM")).toBeNull();
    expect(autoContinueNotice(undefined, "3:00 PM")).toBeNull();
  });

  test("no line when the reset time is unknown (replay/pagination)", () => {
    expect(autoContinueNotice(true, null)).toBeNull();
  });
});
