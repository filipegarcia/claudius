/**
 * The subagent-invocation tool was renamed from "Task" to "Agent" in Claude
 * Code v2.1.63. Current SDK releases emit `Agent` in `tool_use` blocks but
 * still use `Task` in the `system:init` tools list and in
 * `result.permission_denials[].tool_name`, so both literals stay live on the
 * wire — consumers must match either.
 *
 * Centralizing the check here keeps the chat renderer, the verbose filter,
 * and any future surface (background tasks panel, slash-command palette,
 * etc.) reading the same predicate. If the rename ever consolidates to a
 * single literal, only this file has to change.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/subagents (search for
 *      "renamed from Task to Agent")
 */

/** Tool names that route a tool_use block to the subagent / TaskBlock UI. */
export const SUBAGENT_TOOL_NAMES = ["Task", "Agent"] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

/**
 * Returns true when `name` is the subagent-invocation tool under either the
 * legacy ("Task") or current ("Agent") wire name. Use this anywhere the UI
 * branches on "is this a subagent invocation?" — direct string comparisons
 * against one literal will silently drop the other half of the population.
 */
export function isSubagentToolName(name: string | undefined | null): boolean {
  if (!name) return false;
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name);
}
