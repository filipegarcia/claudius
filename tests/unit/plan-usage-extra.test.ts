import { describe, expect, test } from "vitest";
import { normalizeExtraUsage } from "@/lib/shared/plan-usage";

/**
 * CC 2.1.236 (E8) — `/usage` usage-credits row from `rate_limits.extra_usage`.
 */
describe("normalizeExtraUsage (E8)", () => {
  test("maps the SDK snake_case shape to camelCase", () => {
    expect(
      normalizeExtraUsage({
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 12.5,
        utilization: 0.125,
        currency: "USD",
      }),
    ).toEqual({ isEnabled: true, monthlyLimit: 100, usedCredits: 12.5, utilization: 0.125, currency: "USD" });
  });

  test("capped row before any spend: enabled, 0 used", () => {
    const eu = normalizeExtraUsage({ is_enabled: true, monthly_limit: 50, used_credits: 0, utilization: 0 });
    expect(eu).toMatchObject({ isEnabled: true, usedCredits: 0, utilization: 0, currency: null });
  });

  test("null/undefined → null", () => {
    expect(normalizeExtraUsage(null)).toBeNull();
    expect(normalizeExtraUsage(undefined)).toBeNull();
  });
});
