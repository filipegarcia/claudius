import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listSessionTasks, saveSessionTask } from "@/lib/server/session-tasks-db";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { ServerEvent, TaskSnapshotEntry } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for subagent (Task) persistence. The server captures
 * transient `task_*` system events + `parent_tool_use_id` messages off the
 * broadcast stream and flushes them to `session_tasks` on completion, so they
 * survive a disk-rebuild of the session. Each test gets a fresh tmp HOME so
 * migration 007 runs from scratch.
 */

const CWD = "/tmp/fake-session-tasks-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

/**
 * Reach into the private capture hook + in-memory accumulators the same way
 * session-snapshot-state.test.ts does — a standalone shape cast through
 * `unknown`, never an intersection with the class.
 */
type SessionInternals = {
  captureTaskState: (event: ServerEvent) => void;
};

function makeSession(): SessionInternals {
  return new Session({ id: "tasks-test", cwd: CWD }) as unknown as SessionInternals;
}

function startedEvent(taskId: string, toolUseId: string, description: string): ServerEvent {
  return {
    type: "sdk",
    message: {
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
    },
  } as unknown as ServerEvent;
}

function progressEvent(
  taskId: string,
  usage: { total_tokens: number; tool_uses: number; duration_ms: number },
): ServerEvent {
  return {
    type: "sdk",
    message: { type: "system", subtype: "task_progress", task_id: taskId, usage },
  } as unknown as ServerEvent;
}

function notificationEvent(taskId: string, status: string): ServerEvent {
  return {
    type: "sdk",
    message: { type: "system", subtype: "task_notification", task_id: taskId, status },
  } as unknown as ServerEvent;
}

function innerAssistant(toolUseId: string, uuid: string, text: string, at: number): ServerEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: toolUseId,
      message: { id: `m_${uuid}`, content: [{ type: "text", text }] },
    },
  } as unknown as ServerEvent;
}

async function waitForTask(
  taskId: string,
  tries = 50,
): Promise<TaskSnapshotEntry | undefined> {
  for (let i = 0; i < tries; i++) {
    const tasks = await listSessionTasks(CWD, "tasks-test");
    const hit = tasks.find((t) => t.taskId === taskId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
}

describe("session-tasks-db roundtrip", () => {
  test("preserves metadata and inner messages", async () => {
    const entry: TaskSnapshotEntry = {
      taskId: "task-1",
      toolUseId: "toolu-1",
      description: "Find transaction data sources",
      status: "completed",
      totalTokens: 87515,
      toolUses: 22,
      durationMs: 86000,
      summary: "done",
      innerMessages: [{ at: 10, message: { type: "assistant", uuid: "a1" } }],
    };
    await saveSessionTask(CWD, "tasks-test", entry);

    const rows = await listSessionTasks(CWD, "tasks-test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "task-1",
      toolUseId: "toolu-1",
      status: "completed",
      totalTokens: 87515,
      toolUses: 22,
      durationMs: 86000,
    });
    expect(rows[0].innerMessages).toEqual([{ at: 10, message: { type: "assistant", uuid: "a1" } }]);
  });

  test("upserts by (session_id, task_id)", async () => {
    const base: TaskSnapshotEntry = { taskId: "task-1", status: "running", innerMessages: [] };
    await saveSessionTask(CWD, "tasks-test", base);
    await saveSessionTask(CWD, "tasks-test", { ...base, status: "completed", totalTokens: 5 });

    const rows = await listSessionTasks(CWD, "tasks-test");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].totalTokens).toBe(5);
  });
});

describe("Session.captureTaskState end-to-end", () => {
  test("persists counters + inner conversation on task_notification", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-1", "toolu-1", "Find data sources"));
    session.captureTaskState(innerAssistant("toolu-1", "a1", "looking", 100));
    session.captureTaskState(progressEvent("task-1", { total_tokens: 87515, tool_uses: 22, duration_ms: 86000 }));
    session.captureTaskState(innerAssistant("toolu-1", "a2", "found it", 200));
    session.captureTaskState(notificationEvent("task-1", "completed"));

    const persisted = await waitForTask("task-1");
    expect(persisted).toBeDefined();
    expect(persisted!).toMatchObject({
      toolUseId: "toolu-1",
      status: "completed",
      totalTokens: 87515,
      toolUses: 22,
      durationMs: 86000,
    });
    expect(persisted!.innerMessages).toHaveLength(2);
  });

  test("does not persist a task that never completes", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-2", "toolu-2", "still running"));
    session.captureTaskState(progressEvent("task-2", { total_tokens: 10, tool_uses: 1, duration_ms: 500 }));

    // Give any (incorrect) async write a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 30));
    const rows = await listSessionTasks(CWD, "tasks-test");
    expect(rows.find((t) => t.taskId === "task-2")).toBeUndefined();
  });
});
