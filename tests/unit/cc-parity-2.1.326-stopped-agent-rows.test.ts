import { describe, expect, test } from "vitest";
import {
  settledToolLabel,
  settledToolReason,
  settledToolTitle,
} from "@/lib/client/subagent-tool-status";
import { reconcileTasksOnToolResult } from "@/lib/client/task-status";
import type { TaskInfo } from "@/lib/client/types";

/**
 * CC 2.1.326 parity — a stopped or failed agent's last command no longer
 * shows as "Running…": once the subagent settles, a result-less inner tool
 * call reads "Interrupted" with the reason.
 */
describe("settledToolReason", () => {
  test("live subagents keep their result-less calls running", () => {
    expect(settledToolReason("running")).toBeNull();
    expect(settledToolReason("pending")).toBeNull();
    // A usage-limit hold auto-resumes, so the call can still finish.
    expect(settledToolReason("paused")).toBeNull();
    expect(settledToolReason(undefined)).toBeNull();
  });

  test("stopped and killed subagents settle as stopped", () => {
    expect(settledToolReason("stopped")).toBe("stopped");
    expect(settledToolReason("killed")).toBe("stopped");
  });

  test("failed subagents settle; completed ones don't claim a call never ran", () => {
    expect(settledToolReason("failed")).toBe("failed");
    expect(settledToolReason("completed")).toBeNull();
  });
});

describe("settledToolLabel / settledToolTitle", () => {
  test("labels say why the call never ran", () => {
    expect(settledToolLabel("stopped")).toBe("Interrupted · agent stopped");
    expect(settledToolLabel("failed")).toBe("Interrupted · agent failed");
  });

  test("titles explain the label", () => {
    expect(settledToolTitle("stopped")).toMatch(/agent was stopped/);
    expect(settledToolTitle("failed")).toMatch(/agent failed/);
  });
});

describe("parallel agents keep their stopped status", () => {
  // The audit's secondary claim: a late tool_result must not flip a stopped
  // agent to "completed". The reconciler only touches non-terminal tasks.
  test("a tool_result after task_notification(stopped) leaves it stopped", () => {
    const tasks: Record<string, TaskInfo> = {
      a: { taskId: "a", toolUseId: "tu_a", description: "A", status: "stopped" },
      b: { taskId: "b", toolUseId: "tu_b", description: "B", status: "running" },
    };
    const afterA = reconcileTasksOnToolResult(tasks, "tu_a", false, false);
    expect(afterA).toBe(tasks);
    expect(afterA.a.status).toBe("stopped");
    const afterB = reconcileTasksOnToolResult(afterA, "tu_b", false, false);
    expect(afterB.a.status).toBe("stopped");
    expect(afterB.b.status).toBe("completed");
  });

  test("killed and failed are left alone too", () => {
    const tasks: Record<string, TaskInfo> = {
      k: { taskId: "k", toolUseId: "tu_k", description: "K", status: "killed" },
      f: { taskId: "f", toolUseId: "tu_f", description: "F", status: "failed" },
    };
    expect(reconcileTasksOnToolResult(tasks, "tu_k", false, false)).toBe(tasks);
    expect(reconcileTasksOnToolResult(tasks, "tu_f", false, false)).toBe(tasks);
  });
});
