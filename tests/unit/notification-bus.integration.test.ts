import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { notificationBus } from "@/lib/server/notification-bus";
import {
  listNotifications,
  setSessionPrefs,
} from "@/lib/server/notifications-db";
import type { NotificationStreamEvent } from "@/lib/shared/notifications";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { writeFakeWorkspace } from "./helpers/fake-workspace";

/**
 * In-process bus integration: drive `recordSessionEvent` /
 * `recordSchedulerEvent` against a fake workspace, capture the SSE envelopes
 * via `subscribe`, and assert both the fanout and the persisted state.
 *
 * The bus is an HMR singleton on `globalThis`, so we lean on `resetForTests`
 * in `beforeEach` to wipe subscribers/idle-map/counts caches between cases.
 * `makeTempHome` handles HOME redirection + the DB-handle cache.
 */

let tmp: TmpHome;
let envs: NotificationStreamEvent[];
let unsubscribe: () => void;

function snap(): NotificationStreamEvent[] {
  // Defensive copy — callers do indexed reads after later events arrive.
  return envs.slice();
}

beforeEach(() => {
  tmp = makeTempHome();
  notificationBus.resetForTests();
  envs = [];
  unsubscribe = notificationBus.subscribe((e) => envs.push(e));
});

afterEach(() => {
  unsubscribe();
  notificationBus.resetForTests();
  tmp.restore();
});

describe("recordSessionEvent", () => {
  test("error event lands a row and emits notification + count envelopes", async () => {
    const ws = writeFakeWorkspace();

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "boom",
    });

    // Fanout: one `notification`, one `count` (in either order, but in
    // practice notification first).
    const types = snap().map((e) => e.type);
    expect(types).toContain("notification");
    expect(types).toContain("count");
    const notif = snap().find((e) => e.type === "notification");
    expect(notif && notif.type === "notification" && notif.notification.kind).toBe(
      "session_error",
    );
    const count = snap().find((e) => e.type === "count");
    expect(count && count.type === "count" && count.workspaceId).toBe(ws.id);
    expect(count && count.type === "count" && count.unread).toBe(1);

    // Persisted.
    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("boom");
  });

  test("requestId dedup: second event with same requestId emits nothing", async () => {
    const ws = writeFakeWorkspace();
    const ev = {
      type: "permission_request" as const,
      requestId: "req-dup",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    };
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    const firstCount = snap().filter((e) => e.type === "notification").length;
    expect(firstCount).toBe(1);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    const secondCount = snap().filter((e) => e.type === "notification").length;
    expect(secondCount).toBe(1); // unchanged

    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
  });

  test("workspace with notifications.enabled=false drops the event", async () => {
    const ws = writeFakeWorkspace({ notifications: { enabled: false } });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "muted",
    });
    expect(snap()).toEqual([]);
    expect(await listNotifications(ws.rootPath, ws.id)).toEqual([]);
  });

  test("enabledKinds allow-list lets matching kinds through and blocks others", async () => {
    const ws = writeFakeWorkspace({
      notifications: { enabledKinds: ["permission_request"] },
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "should-drop",
    });
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "permission_request",
      requestId: "req-z",
      toolName: "Bash",
      toolUseId: "tu-z",
      input: {},
    });
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("per-session block drops events for that session only", async () => {
    const ws = writeFakeWorkspace();
    await setSessionPrefs(ws.rootPath, "sess-blocked", { blocked: true });

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-blocked", {
      type: "error",
      message: "dropped",
    });
    expect(snap()).toEqual([]);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-clean", {
      type: "error",
      message: "kept",
    });
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("future snoozeUntil suppresses, past snoozeUntil lets through", async () => {
    const ws = writeFakeWorkspace();
    await setSessionPrefs(ws.rootPath, "sess-snz", {
      snoozeUntil: Date.now() + 60_000,
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-snz", {
      type: "error",
      message: "snoozed",
    });
    expect(snap()).toEqual([]);

    await setSessionPrefs(ws.rootPath, "sess-snz", {
      snoozeUntil: Date.now() - 1_000,
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-snz", {
      type: "error",
      message: "post-snooze",
    });
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("subagent SDK message is dropped before workspace lookup", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      // Real SDK shape has many fields; the bus only checks
      // parent_tool_use_id.
      message: { parent_tool_use_id: "tu-parent" } as never,
    });
    expect(snap()).toEqual([]);
  });

  test("count envelope only fires when the workspace total actually changes", async () => {
    const ws = writeFakeWorkspace();

    // First event: count goes 0 → 1, expect a count envelope.
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "a",
    });
    expect(snap().filter((e) => e.type === "count")).toHaveLength(1);

    // Second event: count goes 1 → 2, expect a second count envelope.
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "b",
    });
    expect(snap().filter((e) => e.type === "count")).toHaveLength(2);

    // Third event is a dedup'd permission_request — the row is rejected
    // by the partial UNIQUE index, so the count must NOT advance.
    const ev = {
      type: "permission_request" as const,
      requestId: "req-shared",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    };
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    // Two of the three calls landed a row (3 - 1 dedup'd = 3 total counts:
    // 1, 2, 3 — the second event of the pair was the dedup). So we expect
    // exactly 3 count envelopes total: the original two plus the one
    // permission_request that landed before its dedup'd twin.
    expect(snap().filter((e) => e.type === "count")).toHaveLength(3);
  });
});

describe("recordSchedulerEvent", () => {
  test("run_finished non-success records with status in payload", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSchedulerEvent(
      ws.rootPath,
      "run-1",
      "job-1",
      { type: "run_finished", status: "errored", note: "exit 1" },
    );
    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("scheduled_run_finished");
    expect(rows[0].payload).toEqual({ status: "errored" });
    expect(rows[0].runId).toBe("run-1");
    expect(rows[0].jobId).toBe("job-1");
  });
});

describe("idle heuristic", () => {
  test("without markUserInput, an SDK result is suppressed", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      message: { type: "result" } as never,
    });
    expect(snap()).toEqual([]);
  });

  test("with markUserInput far enough in the past, idle notification fires", async () => {
    const ws = writeFakeWorkspace();
    // 10 seconds ago — past the 5-second IDLE_NOTIFY_MIN_MS window.
    notificationBus.markUserInput("sess-1", Date.now() - 10_000);
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      message: { type: "result" } as never,
    });
    const notif = snap().find((e) => e.type === "notification");
    expect(notif && notif.type === "notification" && notif.notification.kind).toBe(
      "session_idle",
    );
  });
});

describe("markReadByRequestId", () => {
  test("flips the matching row and fires a count envelope", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "permission_request",
      requestId: "req-7",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    });
    const countsBefore = snap().filter((e) => e.type === "count").length;

    await notificationBus.markReadByRequestId(ws.rootPath, "req-7");

    const countEnvs = snap().filter((e) => e.type === "count");
    expect(countEnvs.length).toBeGreaterThan(countsBefore);
    // Final count should be 0 since the only row was just flipped.
    const last = countEnvs[countEnvs.length - 1];
    expect(last.type === "count" && last.unread).toBe(0);
  });

  test("no-op for an unknown requestId — no count envelope", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "x",
    });
    const before = snap().filter((e) => e.type === "count").length;
    await notificationBus.markReadByRequestId(ws.rootPath, "req-never");
    const after = snap().filter((e) => e.type === "count").length;
    expect(after).toBe(before);
  });
});
