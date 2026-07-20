import { describe, expect, it } from "vitest";
import { shouldShowContextWarning } from "@/lib/client/useContextWarning";

describe("shouldShowContextWarning", () => {
  it("gates on the threshold below 100% usage (the tunable soft nudge)", () => {
    expect(shouldShowContextWarning(85, 90)).toBe(false);
    expect(shouldShowContextWarning(90, 90)).toBe(true);
    expect(shouldShowContextWarning(95, 90)).toBe(true);
  });

  it('threshold 100 ("Never") silences the soft nudge below 100% usage', () => {
    expect(shouldShowContextWarning(99, 100)).toBe(false);
    expect(shouldShowContextWarning(100, 100)).toBe(false);
  });

  it("always shows once usage genuinely exceeds the window, even with threshold 100 (CC 2.1.216)", () => {
    // percentage > 100 means the conversation is over the model's context
    // limit, not just close to it — that's not something the "Never nudge
    // me early" preference should be able to hide.
    expect(shouldShowContextWarning(100.5, 100)).toBe(true);
    expect(shouldShowContextWarning(120, 100)).toBe(true);
    expect(shouldShowContextWarning(120, 75)).toBe(true);
  });

  it("ignores missing/non-finite percentage readings", () => {
    expect(shouldShowContextWarning(null, 90)).toBe(false);
    expect(shouldShowContextWarning(undefined, 90)).toBe(false);
    expect(shouldShowContextWarning(Number.NaN, 90)).toBe(false);
  });
});
