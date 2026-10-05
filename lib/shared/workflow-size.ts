/**
 * CC 2.1.219 (H14) — the dynamic-workflow size guideline, shown on a running
 * workflow block (with a pointer to Settings). The `workflowSizeGuideline`
 * setting is advisory ("how large a fan-out to aim for"); when unset the SDK
 * defaults to "medium", so the UI shows that effective default.
 *
 * Pure so the default/validation is unit-testable.
 */

export const WORKFLOW_SIZES = ["unrestricted", "small", "medium", "large"] as const;
export type WorkflowSize = (typeof WORKFLOW_SIZES)[number];

/** The SDK default when the setting is absent. */
export const DEFAULT_WORKFLOW_SIZE: WorkflowSize = "medium";

/** Resolve a raw setting value to a known size, falling back to the default. */
export function effectiveWorkflowSize(value: unknown): WorkflowSize {
  return typeof value === "string" && (WORKFLOW_SIZES as readonly string[]).includes(value)
    ? (value as WorkflowSize)
    : DEFAULT_WORKFLOW_SIZE;
}
