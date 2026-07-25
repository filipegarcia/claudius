import { describe, expect, test } from "vitest";
import { fastModeDisabledReasonLabel } from "@/lib/shared/fast-mode";

/**
 * SDK 0.3.219 added `fast_mode_disabled_reason` to the `result` and
 * `system:init` messages. `fastModeDisabledReasonLabel` maps the ten known
 * reason values to human copy and falls back to the pre-0.3.219 neutral
 * wording for anything it doesn't recognize (the SDK's reason list is an
 * open set that may grow).
 */
describe("fastModeDisabledReasonLabel", () => {
  test("returns curated copy for every known reason", () => {
    const known = [
      "free",
      "preference",
      "extra_usage_disabled",
      "network_error",
      "unknown",
      "not_first_party",
      "disabled_by_env",
      "model_not_allowed",
      "sdk_opt_in_required",
      "pending",
    ] as const;
    for (const reason of known) {
      const label = fastModeDisabledReasonLabel(reason);
      expect(label).toBeTruthy();
      expect(label).not.toBe("Fast mode is temporarily unavailable.");
    }
  });

  test("falls back to neutral copy for an unrecognized reason", () => {
    expect(fastModeDisabledReasonLabel("some_future_reason")).toBe(
      "Fast mode is temporarily unavailable.",
    );
  });

  test("falls back to neutral copy for null/undefined", () => {
    expect(fastModeDisabledReasonLabel(null)).toBe("Fast mode is temporarily unavailable.");
    expect(fastModeDisabledReasonLabel(undefined)).toBe("Fast mode is temporarily unavailable.");
  });
});
