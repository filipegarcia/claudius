import { describe, expect, test } from "vitest";
import { isWorkflowSizeGuideline, WORKFLOW_SIZE_GUIDELINE_VALUES } from "@/lib/server/settings";

/**
 * SDK 0.3.219 added `Settings.workflowSizeGuideline` — the advisory size
 * guideline for "ultracode" (Dynamic Workflows) fan-out. `session.ts`
 * forwards a user's setting to the SDK's flag layer only when it's one of
 * the four known literals (settings.json is hand-editable, and a garbage
 * value has no sensible SDK-side fallback the way a free-form string like
 * `advisorModel` does) — `isWorkflowSizeGuideline` is the gate.
 */
describe("isWorkflowSizeGuideline", () => {
  test("accepts every known literal", () => {
    for (const v of WORKFLOW_SIZE_GUIDELINE_VALUES) {
      expect(isWorkflowSizeGuideline(v)).toBe(true);
    }
  });

  test("rejects an unknown string, non-string, and undefined", () => {
    expect(isWorkflowSizeGuideline("gigantic")).toBe(false);
    expect(isWorkflowSizeGuideline(42)).toBe(false);
    expect(isWorkflowSizeGuideline(undefined)).toBe(false);
    expect(isWorkflowSizeGuideline(null)).toBe(false);
  });
});
