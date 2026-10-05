import { describe, expect, test } from "vitest";
import { DEFAULT_WORKFLOW_SIZE, effectiveWorkflowSize } from "@/lib/shared/workflow-size";

/**
 * CC 2.1.219 (H14) — the effective workflow size guideline shown on a live run.
 */
describe("effectiveWorkflowSize (H14)", () => {
  test("passes through a known value", () => {
    expect(effectiveWorkflowSize("small")).toBe("small");
    expect(effectiveWorkflowSize("unrestricted")).toBe("unrestricted");
    expect(effectiveWorkflowSize("large")).toBe("large");
    expect(effectiveWorkflowSize("medium")).toBe("medium");
  });

  test("falls back to the SDK default (medium) for unset / unknown values", () => {
    expect(effectiveWorkflowSize(undefined)).toBe(DEFAULT_WORKFLOW_SIZE);
    expect(effectiveWorkflowSize(null)).toBe("medium");
    expect(effectiveWorkflowSize("gigantic")).toBe("medium");
    expect(effectiveWorkflowSize(42)).toBe("medium");
  });
});
