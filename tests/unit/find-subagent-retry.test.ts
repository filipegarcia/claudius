import { describe, expect, test } from "vitest";
import { findSubagentRetry } from "@/lib/client/task-status";
import type { ToolProgressInfo } from "@/lib/client/types";

/**
 * SDK 0.3.214 — `tool_progress.subagent_retry` lets a client show a
 * subagent waiting out an API rate-limit retry. It's carried on the
 * subagent's OWN (inner) tool_use progress frame, whose
 * `parent_tool_use_id` points at the outer Task/Agent tool_use — never at
 * itself. `findSubagentRetry` is the lookup TaskBlock uses to surface that
 * state given only the outer Task's `toolUseId`.
 */

const RETRY: NonNullable<ToolProgressInfo["subagentRetry"]> = {
  agentId: "agent_1",
  attempt: 2,
  maxRetries: 5,
  retryDelayMs: 2000,
  errorStatus: 429,
  errorCategory: "rate_limit",
};

function progressEntry(overrides: Partial<ToolProgressInfo>): ToolProgressInfo {
  return {
    toolUseId: "toolu_inner",
    toolName: "Bash",
    elapsedSeconds: 3,
    parentToolUseId: "toolu_task",
    ...overrides,
  };
}

describe("findSubagentRetry", () => {
  test("finds a retry on an inner tool_use whose parentToolUseId matches the Task", () => {
    const progress = { toolu_inner: progressEntry({ subagentRetry: RETRY }) };
    expect(findSubagentRetry("toolu_task", "running", progress)).toEqual(RETRY);
  });

  test("returns undefined when no entry is parented to this Task", () => {
    const progress = {
      toolu_inner: progressEntry({ parentToolUseId: "toolu_other_task", subagentRetry: RETRY }),
    };
    expect(findSubagentRetry("toolu_task", "running", progress)).toBeUndefined();
  });

  test("returns undefined when the matching entry has no subagentRetry (plain progress tick)", () => {
    const progress = { toolu_inner: progressEntry({}) };
    expect(findSubagentRetry("toolu_task", "running", progress)).toBeUndefined();
  });

  test("returns undefined once the Task is no longer running — a finished Task can't be mid-retry", () => {
    const progress = { toolu_inner: progressEntry({ subagentRetry: RETRY }) };
    for (const status of ["completed", "failed", "killed", "stopped", "pending"] as const) {
      expect(findSubagentRetry("toolu_task", status, progress)).toBeUndefined();
    }
  });

  test("returns undefined when progress is undefined (no tool_progress frames yet)", () => {
    expect(findSubagentRetry("toolu_task", "running", undefined)).toBeUndefined();
  });

  test("does NOT match on the Task's own toolUseId directly — retry lives on the inner call", () => {
    // A tool_progress frame keyed BY the outer Task's own id (e.g. a
    // main-thread tool progress reusing the same id, which shouldn't
    // happen, but pins the "must scan parentToolUseId, not the map key"
    // contract) must not be picked up.
    const progress = {
      toolu_task: progressEntry({ toolUseId: "toolu_task", parentToolUseId: null, subagentRetry: RETRY }),
    };
    expect(findSubagentRetry("toolu_task", "running", progress)).toBeUndefined();
  });
});
