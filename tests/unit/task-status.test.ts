import { describe, expect, test } from "vitest";
import {
  findToolUseBlock,
  isBackgroundedToolUse,
  reconcileTasksOnToolResult,
  seedTaskStatus,
  statusFromToolResult,
} from "@/lib/client/task-status";
import type { DisplayMessage, TaskInfo } from "@/lib/client/types";

function task(partial: Partial<TaskInfo> & { taskId: string }): TaskInfo {
  return { description: "d", status: "running", ...partial };
}

function toolUseMsg(
  id: string,
  opts: { result?: { content: string; isError?: boolean }; background?: boolean } = {},
): DisplayMessage {
  return {
    uuid: `m_${id}`,
    role: "assistant",
    blocks: [
      {
        kind: "tool_use",
        id,
        name: "Task",
        input: opts.background ? { run_in_background: true } : {},
        ...(opts.result ? { result: opts.result } : {}),
      },
    ],
  };
}

describe("statusFromToolResult", () => {
  test("maps error → failed, otherwise completed", () => {
    expect(statusFromToolResult(false)).toBe("completed");
    expect(statusFromToolResult(undefined)).toBe("completed");
    expect(statusFromToolResult(true)).toBe("failed");
  });
});

describe("reconcileTasksOnToolResult", () => {
  const base = {
    a: task({ taskId: "a", toolUseId: "toolu_a", status: "running" }),
    b: task({ taskId: "b", toolUseId: "toolu_b", status: "running" }),
  };

  test("flips the matching running task to completed", () => {
    const next = reconcileTasksOnToolResult(base, "toolu_a", false, false);
    expect(next.a.status).toBe("completed");
    expect(next.b.status).toBe("running"); // untouched
  });

  test("flips to failed on an error result", () => {
    expect(reconcileTasksOnToolResult(base, "toolu_a", true, false).a.status).toBe("failed");
  });

  test("leaves already-terminal tasks alone (idempotent)", () => {
    const done = { a: task({ taskId: "a", toolUseId: "toolu_a", status: "completed" }) };
    expect(reconcileTasksOnToolResult(done, "toolu_a", false, false)).toBe(done);
  });

  test("does not complete a backgrounded task (via arg or flag)", () => {
    expect(reconcileTasksOnToolResult(base, "toolu_a", false, true)).toBe(base);
    const bg = { a: task({ taskId: "a", toolUseId: "toolu_a", isBackgrounded: true }) };
    expect(reconcileTasksOnToolResult(bg, "toolu_a", false, false)).toBe(bg);
  });

  test("returns the same reference when nothing matches", () => {
    expect(reconcileTasksOnToolResult(base, "toolu_unknown", false, false)).toBe(base);
  });
});

describe("findToolUseBlock / isBackgroundedToolUse", () => {
  test("finds a block across multiple lists and reads run_in_background", () => {
    const main = [toolUseMsg("toolu_a")];
    const subagent = [toolUseMsg("toolu_bg", { background: true })];
    expect(findToolUseBlock("toolu_a", main, subagent)?.id).toBe("toolu_a");
    expect(isBackgroundedToolUse(findToolUseBlock("toolu_bg", main, subagent))).toBe(true);
    expect(isBackgroundedToolUse(findToolUseBlock("toolu_a", main))).toBe(false);
    expect(findToolUseBlock("missing", main)).toBeNull();
  });
});

describe("seedTaskStatus", () => {
  test("seeds terminal when the tool_result already landed (ordering race)", () => {
    expect(seedTaskStatus(toolUseMsg("x", { result: { content: "ok" } }).blocks[0] as never)).toBe(
      "completed",
    );
    expect(
      seedTaskStatus(toolUseMsg("x", { result: { content: "boom", isError: true } }).blocks[0] as never),
    ).toBe("failed");
  });

  test("stays running with no result, or when backgrounded", () => {
    expect(seedTaskStatus(toolUseMsg("x").blocks[0] as never)).toBe("running");
    expect(
      seedTaskStatus(toolUseMsg("x", { result: { content: "ack" }, background: true }).blocks[0] as never),
    ).toBe("running");
    expect(seedTaskStatus(null)).toBe("running");
  });
});
