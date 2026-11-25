import { describe, expect, test } from "vitest";
import { extraUsageState } from "@/lib/shared/rate-limit-extra-usage";
import { creditsToMajorUnits, extraUsageAtMonthlyLimit, type ExtraUsage } from "@/lib/shared/plan-usage";

/**
 * CC 2.1.329 — "Fixed `/usage` saying usage credits are off when they had run
 * out or reached the monthly limit" and "[VSCode] Fixed the limit banner not
 * saying when usage credits are in use".
 */
describe("extraUsageState — used up is not off", () => {
  test("out of credits, or the org's monthly limit reached → used_up", () => {
    expect(extraUsageState({ overageDisabledReason: "out_of_credits" })).toBe("used_up");
    expect(extraUsageState({ overageDisabledReason: "org_level_disabled_until" })).toBe("used_up");
  });
  test("credits turned on but the overage bucket rejected → used_up", () => {
    expect(extraUsageState({ overageEnabled: true, overageStatus: "rejected" })).toBe("used_up");
  });
  test("a disabling reason still wins and reads off; so does a bare rejection", () => {
    expect(extraUsageState({ overageEnabled: true, overageDisabledReason: "org_level_disabled" })).toBe("off");
    expect(extraUsageState({ overageStatus: "rejected" })).toBe("off");
    expect(extraUsageState({ overageEnabled: false, overageStatus: "rejected" })).toBe("off");
  });
  test("reasons take precedence over status", () => {
    expect(extraUsageState({ overageStatus: "allowed", overageDisabledReason: "out_of_credits" })).toBe("used_up");
    expect(extraUsageState({ overageStatus: "rejected", overageDisabledReason: "member_level_disabled" })).toBe("off");
  });
});

describe("creditsToMajorUnits — amounts are minor units", () => {
  test("cents → dollars for USD (and when no currency is given)", () => {
    expect(creditsToMajorUnits(27140, "USD")).toBe(271.4);
    expect(creditsToMajorUnits(50000, null)).toBe(500);
    expect(creditsToMajorUnits(1999, "eur")).toBe(19.99);
  });
  test("zero-decimal currencies are left as is, like the CLI", () => {
    expect(creditsToMajorUnits(3000, "JPY")).toBe(3000);
    expect(creditsToMajorUnits(3000, "krw")).toBe(3000);
  });
});

describe("extraUsageAtMonthlyLimit — keep the /cost row at the limit", () => {
  const eu = (over: Partial<ExtraUsage>): ExtraUsage => ({
    isEnabled: false,
    monthlyLimit: 50000,
    usedCredits: 50000,
    utilization: 100,
    currency: "USD",
    ...over,
  });
  test("disabled because the spend reached the monthly limit", () => {
    expect(extraUsageAtMonthlyLimit(eu({}))).toBe(true);
    expect(extraUsageAtMonthlyLimit(eu({ usedCredits: 50120 }))).toBe(true);
  });
  test("not when enabled, under the limit, uncapped, or absent", () => {
    expect(extraUsageAtMonthlyLimit(eu({ isEnabled: true }))).toBe(false);
    expect(extraUsageAtMonthlyLimit(eu({ usedCredits: 100 }))).toBe(false);
    expect(extraUsageAtMonthlyLimit(eu({ monthlyLimit: null }))).toBe(false);
    expect(extraUsageAtMonthlyLimit(null)).toBe(false);
  });
});
