import { describe, expect, test } from "vitest";
import { clampPct, rateLimitEventPct } from "@/lib/shared/usage-pct";
import { collectUsageWindows, displayUsagePct, usageTone } from "@/lib/client/usage-windows";

/**
 * CC 2.1.299 — "Fixed /usage, the approaching-limit warning (terminal and VS
 * Code) and the status line sometimes showing more than 100% used". Claudius's
 * bars were already clamped; the printed % (and aria value) now clamp too,
 * while tone logic keeps the raw figure.
 */

const NOW_MS = Date.UTC(2026, 9, 14, 12, 0, 0);

describe("clampPct", () => {
  test("clamps into 0–100", () => {
    expect(clampPct(112)).toBe(100);
    expect(clampPct(100)).toBe(100);
    expect(clampPct(42.5)).toBe(42.5);
    expect(clampPct(0)).toBe(0);
    expect(clampPct(-3)).toBe(0);
  });

  test("non-finite reads as 0", () => {
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("rateLimitEventPct — the approaching-limit pill", () => {
  test("floors the 0–1 fraction like the CLI", () => {
    expect(rateLimitEventPct(0.95)).toBe(95);
    expect(rateLimitEventPct(0.879)).toBe(87);
  });

  test("never reads above 100", () => {
    expect(rateLimitEventPct(1)).toBe(100);
    expect(rateLimitEventPct(1.07)).toBe(100);
  });
});

describe("plan-usage windows over 100%", () => {
  const plan = {
    subscriptionType: "max",
    rateLimitsAvailable: true,
    rateLimits: { sevenDay: { utilization: 112.4, resetsAt: new Date(NOW_MS + 3_600_000).toISOString() } },
    fetchedAt: NOW_MS,
  } as unknown as Parameters<typeof collectUsageWindows>[0];

  test("pct stays raw (tone still reads it as a hard stop), the display clamps", () => {
    const [w] = collectUsageWindows(plan, [], NOW_MS);
    expect(w.pct).toBe(112.4);
    expect(usageTone(w, 80)).toBe("rejected");
    expect(displayUsagePct(w)).toBe(100);
  });

  test("display rounds normal values", () => {
    expect(displayUsagePct({ pct: 87.5 })).toBe(88);
    expect(displayUsagePct({ pct: 99.6 })).toBe(100);
    expect(displayUsagePct({ pct: 3.2 })).toBe(3);
  });
});
