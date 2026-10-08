import { describe, expect, test } from "vitest";
import type { PlanRateLimits } from "@/lib/client/types";
import {
  collectUsageWindows,
  shortUsageLabel,
  usageTone,
  type RateLimitInfo,
} from "@/lib/client/usage-windows";

const NOW_MS = Date.UTC(2026, 9, 8, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function plan(over: Partial<PlanRateLimits> = {}): PlanRateLimits {
  return {
    subscriptionType: "max",
    rateLimitsAvailable: true,
    rateLimits: null,
    fetchedAt: NOW_MS,
    stale: false,
    ...over,
  };
}

describe("collectUsageWindows", () => {
  test("maps plan-usage windows (0–100, ISO) in display order with pill labels", () => {
    const out = collectUsageWindows(
      plan({
        rateLimits: {
          sevenDay: { utilization: 87, resetsAt: iso(NOW_SEC + 3 * 86400) },
          fiveHour: { utilization: 12, resetsAt: iso(NOW_SEC + 3600) },
          sevenDayOpus: null,
        },
        modelScoped: [{ displayName: "Fable", utilization: 40, resetsAt: iso(NOW_SEC + 86400) }],
      }),
      [],
      NOW_MS,
    );
    expect(out.map((w) => [w.key, w.label, w.pct, w.resetsAtSec])).toEqual([
      ["fiveHour", "5-hour limit", 12, NOW_SEC + 3600],
      ["sevenDay", "Weekly limit", 87, NOW_SEC + 3 * 86400],
      ["model:Fable", "Weekly Fable limit", 40, NOW_SEC + 86400],
    ]);
  });

  test("falls back to SDK rate-limit events (0–1 fraction, epoch seconds)", () => {
    const events: RateLimitInfo[] = [
      { rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.87, resetsAt: NOW_SEC + 3600 },
    ];
    expect(collectUsageWindows(null, events, NOW_MS)).toEqual([
      { key: "sevenDay", label: "Weekly limit", pct: 87, resetsAtSec: NOW_SEC + 3600, rejected: false },
    ]);
  });

  test("plan snapshot wins on pct, a live event contributes the hard-stop flag", () => {
    const reset = NOW_SEC + 3600;
    const out = collectUsageWindows(
      plan({ rateLimits: { fiveHour: { utilization: 99, resetsAt: iso(reset) } } }),
      [{ rateLimitType: "five_hour", status: "rejected", utilization: 0.95, resetsAt: reset }],
      NOW_MS,
    );
    expect(out).toEqual([{ key: "fiveHour", label: "5-hour limit", pct: 99, resetsAtSec: reset, rejected: true }]);
  });

  test("drops windows that already reset, so a stale replayed rejection can't leak", () => {
    const out = collectUsageWindows(
      plan({ rateLimits: { fiveHour: { utilization: 5, resetsAt: iso(NOW_SEC + 3600) } } }),
      [
        // Last window's hard stop, replayed from an old transcript.
        { rateLimitType: "five_hour", status: "rejected", utilization: 1, resetsAt: NOW_SEC - 60 },
        { rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.9, resetsAt: NOW_SEC - 1 },
      ],
      NOW_MS,
    );
    expect(out).toEqual([
      { key: "fiveHour", label: "5-hour limit", pct: 5, resetsAtSec: NOW_SEC + 3600, rejected: false },
    ]);
  });

  test("ignores plan data when rate limits aren't available, and events with no percentage", () => {
    const out = collectUsageWindows(
      plan({ rateLimitsAvailable: false, rateLimits: { fiveHour: { utilization: 50, resetsAt: null } } }),
      [
        { rateLimitType: "seven_day", status: "allowed" },
        { rateLimitType: "overage", status: "rejected", resetsAt: NOW_SEC + 60 },
        { status: "allowed_warning", utilization: 0.8 },
      ],
      NOW_MS,
    );
    expect(out).toEqual([
      { key: "overage", label: "Extra-usage limit", pct: 100, resetsAtSec: NOW_SEC + 60, rejected: true },
    ]);
  });
});

describe("usageTone", () => {
  const w = (pct: number, rejected = false) => ({ key: "k", label: "l", pct, rejected });
  test("amber at the user's pill threshold, red at a hard stop", () => {
    expect(usageTone(w(49), 50)).toBe("ok");
    expect(usageTone(w(50), 50)).toBe("warning");
    expect(usageTone(w(100), 50)).toBe("rejected");
    expect(usageTone(w(10, true), 50)).toBe("rejected");
  });
  test("an 'Always' threshold of 0 doesn't paint an unused window amber", () => {
    expect(usageTone(w(0), 0)).toBe("ok");
    expect(usageTone(w(1), 0)).toBe("warning");
  });
});

describe("shortUsageLabel", () => {
  test("compact names for the minimized row", () => {
    expect(shortUsageLabel({ key: "fiveHour", label: "5-hour limit" })).toBe("5-hour");
    expect(shortUsageLabel({ key: "sevenDay", label: "Weekly limit" })).toBe("Weekly");
    expect(shortUsageLabel({ key: "model:Fable", label: "Weekly Fable limit" })).toBe("Fable");
    expect(shortUsageLabel({ key: "somethingNew", label: "Some new limit" })).toBe("Some new limit");
  });
});
