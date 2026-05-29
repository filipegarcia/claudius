import { describe, expect, test } from "vitest";
import {
  collectStoppableTaskIds,
  dropProvisionalForToolUse,
  findToolUseBlock,
  hasRealTaskForToolUse,
  isBackgroundedToolUse,
  reconcileTasksOnToolResult,
  seedTaskStatus,
  statusFromToolResult,
  upsertProvisionalTask,
} from "@/lib/client/task-status";
import type { DisplayMessage, TaskInfo } from "@/lib/client/types";

function task(partial: Partial<TaskInfo> & { taskId: string }): TaskInfo {
  return { description: "d", status: "running", ...partial };
}

function toolUseMsg(
  id: string,
  opts: {
    result?: { content: string; isError?: boolean };
    background?: boolean;
    name?: string;
  } = {},
): DisplayMessage {
  return {
    uuid: `m_${id}`,
    role: "assistant",
    blocks: [
      {
        kind: "tool_use",
        id,
        name: opts.name ?? "Task",
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

  test("treats the Workflow tool as backgrounded (its 0s ack is not completion)", () => {
    // The Workflow tool never sets run_in_background, but its tool_result is a
    // "started, here's the runId" ack — the real result rides on
    // task_notification. Without this, the ack would mis-complete the still-
    // running workflow task.
    const main = [toolUseMsg("toolu_wf", { name: "Workflow" })];
    expect(isBackgroundedToolUse(findToolUseBlock("toolu_wf", main))).toBe(true);
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
    // The Workflow tool's 0s ack must not seed "completed".
    expect(
      seedTaskStatus(
        toolUseMsg("x", { result: { content: "runId: wf_abc" }, name: "Workflow" }).blocks[0] as never,
      ),
    ).toBe("running");
    expect(seedTaskStatus(null)).toBe("running");
  });
});

describe("provisional workflow task lifecycle", () => {
  const provisional = (toolUseId: string, startedAt = 1000): TaskInfo & { toolUseId: string } => ({
    taskId: toolUseId,
    toolUseId,
    description: "Workflow foo",
    taskType: "local_workflow",
    workflowName: "foo",
    status: "running",
    isBackgrounded: true,
    startedAt,
    provisional: true,
  });

  test("upsert seeds a provisional row keyed by tool_use_id", () => {
    const next = upsertProvisionalTask({}, provisional("toolu_wf"));
    expect(next.toolu_wf.provisional).toBe(true);
    expect(next.toolu_wf.status).toBe("running");
  });

  test("upsert is a no-op when a real task already owns the tool_use_id", () => {
    const real = { t1: task({ taskId: "t1", toolUseId: "toolu_wf", status: "running" }) };
    expect(upsertProvisionalTask(real, provisional("toolu_wf"))).toBe(real);
    expect(hasRealTaskForToolUse(real, "toolu_wf")).toBe(true);
  });

  test("upsert is idempotent against a replayed launch ack", () => {
    const once = upsertProvisionalTask({}, provisional("toolu_wf"));
    expect(upsertProvisionalTask(once, provisional("toolu_wf"))).toBe(once);
  });

  test("drop removes the provisional and carries its startedAt forward", () => {
    const seeded = upsertProvisionalTask({}, provisional("toolu_wf", 4242));
    const { tasks: after, carriedStartedAt } = dropProvisionalForToolUse(seeded, "toolu_wf");
    expect(after.toolu_wf).toBeUndefined();
    expect(carriedStartedAt).toBe(4242);
  });

  test("drop leaves a real (non-provisional) row alone", () => {
    const real = { toolu_wf: task({ taskId: "toolu_wf", toolUseId: "toolu_wf", status: "running" }) };
    expect(dropProvisionalForToolUse(real, "toolu_wf").tasks).toBe(real);
  });

  // The blocking leak: a task_notification can arrive with NO prior task_started
  // (the module exists because these events aren't reliably ordered). The
  // notification keys by task_id, so without dropping the provisional (keyed by
  // tool_use_id) it would strand a phantom "running" row forever.
  test("notification-without-started leaves no running row (no phantom)", () => {
    // tool_result(Workflow) → provisional seeded.
    let tasks: Record<string, TaskInfo> = upsertProvisionalTask({}, provisional("toolu_wf"));
    // task_notification arrives under a distinct task_id, carrying tool_use_id.
    const { tasks: cleared } = dropProvisionalForToolUse(tasks, "toolu_wf");
    tasks = {
      ...cleared,
      task_real: { taskId: "task_real", toolUseId: "toolu_wf", description: "done", status: "completed" },
    };
    const running = Object.values(tasks).filter((t) => t.status === "running");
    expect(running).toHaveLength(0);
    expect(Object.values(tasks).filter((t) => t.provisional)).toHaveLength(0);
  });

  // Reconnect duplicate guard: a replayed launch ack re-seeds a provisional;
  // the task_snapshot then drops it and installs the real row → exactly one.
  test("reconnect (ack replay + snapshot) yields exactly one row", () => {
    // Order A: ack replay first, then snapshot.
    let a: Record<string, TaskInfo> = upsertProvisionalTask({}, provisional("toolu_wf"));
    const { tasks: aCleared } = dropProvisionalForToolUse(a, "toolu_wf"); // snapshot drops provisional
    a = { ...aCleared, task_real: task({ taskId: "task_real", toolUseId: "toolu_wf", status: "running" }) };
    expect(Object.values(a).filter((t) => t.toolUseId === "toolu_wf")).toHaveLength(1);

    // Order B: snapshot first, then ack replay → upsert no-ops on the real row.
    let b: Record<string, TaskInfo> = {
      task_real: task({ taskId: "task_real", toolUseId: "toolu_wf", status: "running" }),
    };
    b = upsertProvisionalTask(b, provisional("toolu_wf"));
    expect(Object.values(b).filter((t) => t.toolUseId === "toolu_wf")).toHaveLength(1);
  });
});

describe("collectStoppableTaskIds (Stop-all fan-out set)", () => {
  const byToolUse = (tasks: TaskInfo[]): Map<string, TaskInfo> => {
    const m = new Map<string, TaskInfo>();
    for (const t of tasks) if (t.toolUseId) m.set(t.toolUseId, t);
    return m;
  };

  test("unions the three stoppable sources", () => {
    const sub = task({ taskId: "agent_1", status: "running" });
    const proc = task({ taskId: "mon_1", taskType: "local_monitor", status: "running" });
    const bashTask = task({ taskId: "bash_1", toolUseId: "toolu_b", taskType: "local_bash" });
    const ids = collectStoppableTaskIds([sub], [proc], [{ toolUseId: "toolu_b" }], byToolUse([bashTask]));
    expect([...ids].sort()).toEqual(["agent_1", "bash_1", "mon_1"]);
  });

  test("includes a shell only when its toolUseId resolves to a task (count stays honest)", () => {
    const resolved = task({ taskId: "bash_ok", toolUseId: "toolu_ok", taskType: "local_bash" });
    // A shell whose toolUseId has no matching task — and a task missing taskId —
    // must NOT contribute, mirroring the per-item Stop visibility.
    const map = byToolUse([resolved]);
    const ids = collectStoppableTaskIds(
      [],
      [],
      [{ toolUseId: "toolu_ok" }, { toolUseId: "toolu_unknown" }],
      map,
    );
    expect([...ids]).toEqual(["bash_ok"]);
  });

  test("dedupes overlapping ids so .size is the true confirm count", () => {
    // Same underlying task reachable as both a subagent and via a shell's
    // resolved taskId — must count once.
    const shared = task({ taskId: "dup", toolUseId: "toolu_dup", status: "running" });
    const ids = collectStoppableTaskIds(
      [shared],
      [],
      [{ toolUseId: "toolu_dup" }],
      byToolUse([shared]),
    );
    expect(ids.size).toBe(1);
    expect([...ids]).toEqual(["dup"]);
  });

  test("empty inputs → empty set (button hidden, stopAll no-ops)", () => {
    expect(collectStoppableTaskIds([], [], [], new Map()).size).toBe(0);
  });
});
