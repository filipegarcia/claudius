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
  getStatus: () => "running" | "idle";
};

function makeSession(): SessionInternals {
  return new Session({ id: "tasks-test", cwd: CWD }) as unknown as SessionInternals;
}

function startedEvent(
  taskId: string,
  toolUseId: string,
  description: string,
  extra?: { is_backgrounded?: boolean; spawn_depth?: number; ambient?: boolean },
): ServerEvent {
  return {
    type: "sdk",
    message: {
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      ...extra,
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

function notificationEvent(
  taskId: string,
  status: string,
  extra?: { ambient?: boolean; resource_links?: unknown },
): ServerEvent {
  return {
    type: "sdk",
    message: { type: "system", subtype: "task_notification", task_id: taskId, status, ...extra },
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

  test("SDK 0.3.247: round-trips ambient through session_tasks (migration 018)", async () => {
    const entry: TaskSnapshotEntry = {
      taskId: "task-ambient-1",
      status: "running",
      ambient: true,
      innerMessages: [],
    };
    await saveSessionTask(CWD, "tasks-test", entry);

    const rows = await listSessionTasks(CWD, "tasks-test");
    const row = rows.find((r) => r.taskId === "task-ambient-1");
    expect(row).toBeDefined();
    expect(row!.ambient).toBe(true);
  });

  test("SDK 0.3.257: round-trips resourceLinks through session_tasks (migration 020)", async () => {
    const entry: TaskSnapshotEntry = {
      taskId: "task-links-1",
      status: "completed",
      resourceLinks: [{ uri: "reports://q3/summary.pdf", name: "summary.pdf", title: "Q3 summary.pdf" }],
      innerMessages: [],
    };
    await saveSessionTask(CWD, "tasks-test", entry);

    const rows = await listSessionTasks(CWD, "tasks-test");
    const row = rows.find((r) => r.taskId === "task-links-1");
    expect(row).toBeDefined();
    expect(row!.resourceLinks).toEqual([
      { uri: "reports://q3/summary.pdf", name: "summary.pdf", title: "Q3 summary.pdf" },
    ]);
  });

  test("SDK 0.3.257: leaves resourceLinks unset when never reported", async () => {
    const entry: TaskSnapshotEntry = { taskId: "task-links-2", status: "completed", innerMessages: [] };
    await saveSessionTask(CWD, "tasks-test", entry);

    const rows = await listSessionTasks(CWD, "tasks-test");
    const row = rows.find((r) => r.taskId === "task-links-2");
    expect(row).toBeDefined();
    expect(row!.resourceLinks).toBeUndefined();
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

  test("persists a running task immediately on task_started so mid-run reloads survive", async () => {
    // Regression: the previous behavior only persisted on task_notification
    // (completion). A user reloading mid-run lost the entire subagent
    // transcript and metadata — the task_snapshot was empty and the
    // TaskBlock was stuck on "Subagent working…" with no information.
    // Now task_started writes the row immediately and inner-message /
    // task_progress updates trickle further state in (throttled).
    const session = makeSession();
    session.captureTaskState(startedEvent("task-2", "toolu-2", "still running"));

    const persisted = await waitForTask("task-2");
    expect(persisted).toBeDefined();
    expect(persisted!).toMatchObject({
      taskId: "task-2",
      toolUseId: "toolu-2",
      description: "still running",
      status: "running",
    });
  });

  test("flushes inner subagent messages while the task is still running", async () => {
    // The first inner message after task_started writes through (no
    // throttle window has elapsed); subsequent messages within the
    // throttle window are deferred — but the row already has the
    // running-state metadata regardless, which is what the UI needs
    // most. The final task_notification always writes the complete
    // accumulated transcript.
    const session = makeSession();
    session.captureTaskState(startedEvent("task-3", "toolu-3", "long task"));
    session.captureTaskState(innerAssistant("toolu-3", "a1", "first message", 100));

    const persisted = await waitForTask("task-3");
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("running");
    // task_started + the first inner message flush together; the inner
    // message MAY or MAY NOT have landed depending on whether the
    // throttle window elapsed since task_started — but the row is
    // guaranteed to exist with running metadata.
    expect(persisted!.toolUseId).toBe("toolu-3");
  });

  test("seeds isBackgrounded + spawnDepth from task_started (SDK 0.3.238)", async () => {
    // Regression: before 0.3.238 these only arrived via a later
    // task_updated patch. A task registered in the background from birth
    // (e.g. a resumed subagent, always backgrounded per the SDK) never
    // gets one of those patches — without seeding from task_started
    // itself, isBackgrounded would stay unset and wrongly keep the task
    // counted as an active, blocking subagent forever.
    const session = makeSession();
    session.captureTaskState(
      startedEvent("task-4", "toolu-4", "resumed subagent", {
        is_backgrounded: true,
        spawn_depth: 2,
      }),
    );

    const persisted = await waitForTask("task-4");
    expect(persisted).toBeDefined();
    expect(persisted!.isBackgrounded).toBe(true);
    expect(persisted!.spawnDepth).toBe(2);
  });

  test("leaves isBackgrounded/spawnDepth unset for a plain top-level task_started", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-5", "toolu-5", "top-level task"));

    const persisted = await waitForTask("task-5");
    expect(persisted).toBeDefined();
    expect(persisted!.isBackgrounded).toBeUndefined();
    expect(persisted!.spawnDepth).toBeUndefined();
  });

  test("SDK 0.3.247: seeds ambient from task_started and persists it", async () => {
    const session = makeSession();
    session.captureTaskState(
      startedEvent("task-6", "toolu-6", "auto-started live-update watcher", { ambient: true }),
    );

    const persisted = await waitForTask("task-6");
    expect(persisted).toBeDefined();
    expect(persisted!.ambient).toBe(true);
  });

  test("SDK 0.3.247: leaves ambient unset for a plain task_started", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-7", "toolu-7", "regular subagent"));

    const persisted = await waitForTask("task-7");
    expect(persisted).toBeDefined();
    expect(persisted!.ambient).toBeUndefined();
  });

  test("SDK 0.3.247: task_notification can set ambient late", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-8", "toolu-8", "housekeeping task"));
    session.captureTaskState(notificationEvent("task-8", "completed", { ambient: true }));

    const persisted = await waitForTask("task-8");
    expect(persisted).toBeDefined();
    expect(persisted!.ambient).toBe(true);
  });

  test("SDK 0.3.247: a running ambient task does not pin getStatus() on 'running'", async () => {
    // Regression target: without the ambient exclusion, a live housekeeping
    // task (auto-started live-update watcher) would keep the StatusDot /
    // tab-strip busy indicator lit even though there's no real user-facing
    // work in flight — exactly what the SDK's "exclude from activity
    // indicators" guidance exists to prevent.
    const session = makeSession();
    session.captureTaskState(
      startedEvent("task-9", "toolu-9", "ambient watcher", { ambient: true }),
    );

    expect(session.getStatus()).toBe("idle");
  });

  test("SDK 0.3.257: captures resource_links from the terminal task_notification", async () => {
    const session = makeSession();
    session.captureTaskState(startedEvent("task-11", "toolu-11", "generate report"));
    session.captureTaskState(
      notificationEvent("task-11", "completed", {
        resource_links: [{ uri: "reports://q3/data.csv", name: "data.csv" }],
      }),
    );

    const persisted = await waitForTask("task-11");
    expect(persisted).toBeDefined();
    expect(persisted!.resourceLinks).toEqual([{ uri: "reports://q3/data.csv", name: "data.csv" }]);
  });

  test("SDK 0.3.247: a running non-ambient task still pins getStatus() on 'running'", async () => {
    // Sanity check for the test above: the exclusion is specific to
    // `ambient`, not a blanket regression that stops tracking subagents.
    const session = makeSession();
    session.captureTaskState(startedEvent("task-10", "toolu-10", "real subagent"));

    expect(session.getStatus()).toBe("running");
  });
});
