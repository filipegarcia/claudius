import { describe, expect, test } from "vitest";
import {
  SUBAGENT_TOOL_NAMES,
  isSubagentToolName,
} from "@/lib/shared/subagent-tool";

/**
 * Pin down the dual-name match for the subagent tool. The SDK renamed
 * "Task" → "Agent" in Claude Code v2.1.63 but kept "Task" in system:init
 * and permission_denials, so both wire names stay live. The chat renderer
 * uses this predicate to decide whether a tool_use block routes to
 * TaskBlock (subagent UI) vs. the generic ToolCall pill — matching only
 * one of the two literals silently broke subagent rendering on current
 * SDK builds.
 */
describe("isSubagentToolName", () => {
  test("accepts the legacy name", () => {
    expect(isSubagentToolName("Task")).toBe(true);
  });

  test("accepts the current SDK name", () => {
    expect(isSubagentToolName("Agent")).toBe(true);
  });

  test("rejects unrelated tool names", () => {
    expect(isSubagentToolName("Bash")).toBe(false);
    expect(isSubagentToolName("Read")).toBe(false);
    expect(isSubagentToolName("AskUserQuestion")).toBe(false);
    expect(isSubagentToolName("TodoWrite")).toBe(false);
  });

  test("rejects empty / nullish inputs without throwing", () => {
    expect(isSubagentToolName("")).toBe(false);
    expect(isSubagentToolName(null)).toBe(false);
    expect(isSubagentToolName(undefined)).toBe(false);
  });

  test("is case-sensitive — defensive against future case-folding drift in the SDK", () => {
    // The wire format is exact-case; a lowercase "task" or "agent" coming
    // through would indicate corrupted data, not the canonical tool. We
    // want the renderer to NOT treat those as subagent invocations.
    expect(isSubagentToolName("task")).toBe(false);
    expect(isSubagentToolName("agent")).toBe(false);
    expect(isSubagentToolName("AGENT")).toBe(false);
  });

  test("SUBAGENT_TOOL_NAMES exports both wire names in a stable order", () => {
    // Order matters for round-trip tests and any UI that lists the
    // recognized names; keep "Task" first because that's the legacy one
    // and serves as documentation of the rename history.
    expect(SUBAGENT_TOOL_NAMES).toEqual(["Task", "Agent"]);
  });
});
