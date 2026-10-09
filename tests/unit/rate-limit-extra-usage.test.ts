import { describe, expect, test } from "vitest";
import { extraUsageState } from "@/lib/shared/rate-limit-extra-usage";

/**
 * CC 2.1.295 parity — usage-limit warnings say whether the account has extra
 * usage turned on. `extraUsageState` collapses the SDKRateLimitInfo overage
 * fields into "on" | "off" | null for RateLimitPill.
 */
describe("extraUsageState (CC 2.1.295)", () => {
  test("no overage signal → null (say nothing)", () => {
    expect(extraUsageState(undefined)).toBeNull();
    expect(extraUsageState(null)).toBeNull();
    expect(extraUsageState({})).toBeNull();
    expect(extraUsageState({ rateLimitType: "five_hour" })).toBeNull();
    expect(extraUsageState({ isUsingOverage: false, overageInUse: false })).toBeNull();
  });

  test("overage allowed / allowed_warning → on", () => {
    expect(extraUsageState({ overageStatus: "allowed" })).toBe("on");
    expect(extraUsageState({ overageStatus: "allowed_warning" })).toBe("on");
  });

  test("already drawing from extra usage → on", () => {
    expect(extraUsageState({ isUsingOverage: true })).toBe("on");
    expect(extraUsageState({ overageInUse: true })).toBe("on");
  });

  test("a disabled reason → off", () => {
    expect(extraUsageState({ overageDisabledReason: "org_level_disabled" })).toBe("off");
    expect(extraUsageState({ overageDisabledReason: "out_of_credits" })).toBe("off");
  });

  test("overage bucket rejected → off", () => {
    expect(extraUsageState({ overageStatus: "rejected" })).toBe("off");
  });

  test("off signals win over on signals", () => {
    expect(extraUsageState({ overageStatus: "rejected", isUsingOverage: true })).toBe("off");
    expect(extraUsageState({ overageStatus: "allowed", overageDisabledReason: "out_of_credits" })).toBe(
      "off",
    );
    expect(extraUsageState({ overageInUse: true, overageDisabledReason: "org_level_disabled" })).toBe(
      "off",
    );
  });

  test("an unreadable status (fetch_error / unknown) isn't an off signal", () => {
    expect(extraUsageState({ overageDisabledReason: "fetch_error" })).toBeNull();
    expect(extraUsageState({ overageDisabledReason: "unknown" })).toBeNull();
    expect(extraUsageState({ overageInUse: true, overageDisabledReason: "unknown" })).toBe("on");
    expect(extraUsageState({ overageStatus: "allowed", overageDisabledReason: "fetch_error" })).toBe("on");
    expect(extraUsageState({ overageStatus: "rejected", overageDisabledReason: "fetch_error" })).toBe("off");
  });

  test("SDK 0.3.295 overageEnabled: false → off, true → on", () => {
    expect(extraUsageState({ overageEnabled: false })).toBe("off");
    expect(extraUsageState({ overageEnabled: true })).toBe("on");
    expect(extraUsageState({ overageEnabled: false, isUsingOverage: true })).toBe("off");
    expect(extraUsageState({ overageEnabled: true, overageStatus: "rejected" })).toBe("off");
    expect(extraUsageState({ overageEnabled: true, overageDisabledReason: "out_of_credits" })).toBe("off");
    expect(extraUsageState({ rateLimitType: "overage", overageEnabled: true })).toBeNull();
  });

  test("a warning about the extra-usage limit itself → null", () => {
    expect(extraUsageState({ rateLimitType: "overage", overageStatus: "allowed" })).toBeNull();
    expect(
      extraUsageState({ rateLimitType: "overage", overageDisabledReason: "out_of_credits" }),
    ).toBeNull();
  });
});
