import { describe, expect, test } from "vitest";
import { Session } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Coverage for `Session.updateTodoItem` — the user-driven per-item status
 * flip / delete invoked from the chat-level TodosBanner and the rail's
 * To-dos widget. Surfaces the three behaviors we care about:
 *
 *   1. Mutation semantics — status flip for complete/reopen/in_progress,
 *      filter-out for delete.
 *   2. Override persistence — the mutation lands in `manualTodoOverrides`
 *      so a future replay can re-apply it (the disk side is integration-
 *      tested separately; here we pin the in-memory map state).
 *   3. Clear-on-touch — when the model later touches an id with an active
 *      override via TodoWrite / TaskCreate / TaskUpdate, the override
 *      drops so the model's fresh assertion wins on the next replay.
 *
 * Failure-mode coverage: empty snapshot, unknown id, and unknown action
 * all return `{ok: false}` instead of mutating.
 */

type SessionInternals = {
  latestTodosSnapshot: unknown[] | null;
  latestTodosSnapshotAt: number;
  manualTodoOverrides: Record<string, "completed" | "pending" | "in_progress" | "deleted">;
  isReplayingTranscript: boolean;
  captureSnapshotState: (event: ServerEvent) => void;
  applyManualTodoOverrides: () => number;
};

function makeSession(): { internal: SessionInternals; raw: Session } {
  const raw = new Session({ id: "update-todo-item-test" });
  return { internal: raw as unknown as SessionInternals, raw };
}

function todoWriteEvent(uuid: string, todos: unknown[], at: number): ServerEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        id: uuid,
        content: [{ type: "tool_use", id: `tool-${uuid}`, name: "TodoWrite", input: { todos } }],
      },
    },
  } as unknown as ServerEvent;
}

function taskUpdateEvent(
  uuid: string,
  taskId: string,
  status: string,
  at: number,
): ServerEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        id: uuid,
        content: [
          {
            type: "tool_use",
            id: `tool-${uuid}`,
            name: "TaskUpdate",
            input: { taskId, status },
          },
        ],
      },
    },
  } as unknown as ServerEvent;
}

describe("Session.updateTodoItem — mutation semantics", () => {
  test("complete flips status to completed and records the override", async () => {
    const { internal, raw } = makeSession();
    const todos = [
      { id: "1", content: "do thing", status: "pending" },
      { id: "2", content: "other thing", status: "pending" },
    ];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));

    const result = await raw.updateTodoItem("1", "complete");
    expect(result.ok).toBe(true);

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "do thing", status: "completed" },
      { id: "2", content: "other thing", status: "pending" },
    ]);
    expect(internal.manualTodoOverrides).toEqual({ "1": "completed" });
  });

  test("reopen flips status to pending", async () => {
    const { internal, raw } = makeSession();
    const todos = [{ id: "1", content: "thing", status: "completed" }];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));

    const result = await raw.updateTodoItem("1", "reopen");
    expect(result.ok).toBe(true);

    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "1",
      status: "pending",
    });
    expect(internal.manualTodoOverrides).toEqual({ "1": "pending" });
  });

  test("in_progress flips status to in_progress", async () => {
    const { internal, raw } = makeSession();
    const todos = [{ id: "1", content: "thing", status: "pending" }];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));

    const result = await raw.updateTodoItem("1", "in_progress");
    expect(result.ok).toBe(true);

    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "1",
      status: "in_progress",
    });
    expect(internal.manualTodoOverrides).toEqual({ "1": "in_progress" });
  });

  test("delete filters the item out of the snapshot", async () => {
    const { internal, raw } = makeSession();
    const todos = [
      { id: "1", content: "a", status: "pending" },
      { id: "2", content: "b", status: "pending" },
    ];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));

    const result = await raw.updateTodoItem("1", "delete");
    expect(result.ok).toBe(true);

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "2", content: "b", status: "pending" },
    ]);
    expect(internal.manualTodoOverrides).toEqual({ "1": "deleted" });
  });

  test("bumps the cutoff so a racing pre-update TodoWrite can't undo the change", async () => {
    const { internal, raw } = makeSession();
    const todos = [{ id: "1", content: "thing", status: "pending" }];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));
    const before = internal.latestTodosSnapshotAt;

    const result = await raw.updateTodoItem("1", "complete");
    expect(result.ok).toBe(true);

    // Cutoff bumped to wall-clock — strictly greater than the seed `at`.
    expect(internal.latestTodosSnapshotAt).toBeGreaterThan(before);
  });
});

describe("Session.updateTodoItem — failure modes", () => {
  test("rejects when no snapshot exists", async () => {
    const { raw, internal } = makeSession();
    expect(internal.latestTodosSnapshot).toBeNull();

    const result = await raw.updateTodoItem("1", "complete");
    expect(result).toEqual({ ok: false, error: "no active todo list" });
  });

  test("rejects when the item id is not present", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    const result = await raw.updateTodoItem("missing", "complete");
    expect(result).toEqual({ ok: false, error: "item not found" });
    // Snapshot intact.
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "a", status: "pending" },
    ]);
  });

  test("rejects an empty item id", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    const result = await raw.updateTodoItem("", "complete");
    expect(result).toEqual({ ok: false, error: "invalid item id" });
  });
});

describe("Session — clear-on-touch for manual overrides", () => {
  // `updateTodoItem` bumps the snapshot cutoff to `Date.now()`, so any
  // subsequent model event has to use a timestamp >= wall-clock to land
  // past the guard. Use Number.MAX_SAFE_INTEGER as a "definitely after"
  // sentinel — realistic live `at` values come from `Date.now()` inside
  // `broadcast`, so a synthetic large value mirrors the live ordering.
  const FUTURE = Number.MAX_SAFE_INTEGER;

  test("TaskUpdate on an id with an active override drops the override", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "task-a", content: "a", status: "pending" }], 1_000),
    );

    await raw.updateTodoItem("task-a", "complete");
    expect(internal.manualTodoOverrides).toEqual({ "task-a": "completed" });

    // Model now engages with the same id — override should drop. TaskUpdate
    // has no cutoff guard (it operates on the live snapshot), so the `at`
    // here is informational; the clear-on-touch fires regardless.
    internal.captureSnapshotState(
      taskUpdateEvent("u-upd", "task-a", "in_progress", FUTURE),
    );

    expect(internal.manualTodoOverrides).toEqual({});
    // Snapshot now reflects the model's fresh assertion, not the override.
    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "task-a",
      status: "in_progress",
    });
  });

  test("TodoWrite that includes the override's id drops the override", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    await raw.updateTodoItem("1", "complete");
    expect(internal.manualTodoOverrides).toEqual({ "1": "completed" });

    // Model re-emits a TodoWrite containing the same id with a different
    // status. TodoWrite uses the cutoff guard (`at >= latestTodosSnapshotAt`),
    // so the event must be stamped after the wall-clock-bumped cutoff —
    // matching the live ordering where the model's TodoWrite arrives via
    // `broadcast` with `at = Date.now()` AFTER the user's click.
    internal.captureSnapshotState(
      todoWriteEvent("u-rewrite", [{ id: "1", content: "a", status: "in_progress" }], FUTURE),
    );

    expect(internal.manualTodoOverrides).toEqual({});
  });

  test("TaskUpdate on an unrelated id leaves other overrides alone", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent(
        "u-init",
        [
          { id: "1", content: "a", status: "pending" },
          { id: "2", content: "b", status: "pending" },
        ],
        1_000,
      ),
    );

    await raw.updateTodoItem("1", "complete");
    await raw.updateTodoItem("2", "delete");
    expect(internal.manualTodoOverrides).toEqual({
      "1": "completed",
      "2": "deleted",
    });

    // Model touches a third id — unrelated to both overrides. TaskUpdate
    // is no-op when the id isn't in the snapshot, but the clear-on-touch
    // logic should still be safe (no-ops on the override map).
    internal.captureSnapshotState(
      taskUpdateEvent("u-other", "3", "in_progress", FUTURE),
    );

    expect(internal.manualTodoOverrides).toEqual({
      "1": "completed",
      "2": "deleted",
    });
  });
});

describe("Session.clearTodos — auto-clear toast broadcast", () => {
  // The transient `todos_auto_cleared` event surfaces a small inline toast
  // when the SERVER closes the list (stale 24h sweep or all-completed turn
  // end). Manual clears (user clicked Clear) deliberately do NOT broadcast
  // it — the user already knows what they just did.
  test("broadcasts the toast event for a `completed` clear", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent(
        "u-init",
        [
          { id: "1", content: "a", status: "completed" },
          { id: "2", content: "b", status: "completed" },
        ],
        1_000,
      ),
    );

    const seen: Array<{ type: string; reason?: string; count?: number }> = [];
    const unsubscribe = raw.subscribe((ev) => {
      seen.push(ev as { type: string; reason?: string; count?: number });
    });

    await raw.clearTodos("completed");
    unsubscribe();

    const toast = seen.find((e) => e.type === "todos_auto_cleared");
    expect(toast).toBeDefined();
    expect(toast?.reason).toBe("completed");
    expect(toast?.count).toBe(2);
  });

  test("broadcasts the toast event for a `stale` clear", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    const seen: Array<{ type: string; reason?: string; count?: number }> = [];
    const unsubscribe = raw.subscribe((ev) => {
      seen.push(ev as { type: string; reason?: string; count?: number });
    });

    await raw.clearTodos("stale");
    unsubscribe();

    const toast = seen.find((e) => e.type === "todos_auto_cleared");
    expect(toast).toBeDefined();
    expect(toast?.reason).toBe("stale");
    expect(toast?.count).toBe(1);
  });

  test("does NOT broadcast the toast for a manual clear (user already knows)", async () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-init", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    const seen: Array<{ type: string }> = [];
    const unsubscribe = raw.subscribe((ev) => {
      seen.push(ev as { type: string });
    });

    await raw.clearTodos("manual");
    unsubscribe();

    expect(seen.find((e) => e.type === "todos_auto_cleared")).toBeUndefined();
    // The empty `session_snapshot` still fires — the UI needs it to repaint.
    expect(seen.find((e) => e.type === "session_snapshot")).toBeDefined();
  });

  test("does NOT broadcast the toast when the snapshot was already empty", async () => {
    const { raw } = makeSession();

    const seen: Array<{ type: string }> = [];
    const unsubscribe = raw.subscribe((ev) => {
      seen.push(ev as { type: string });
    });

    await raw.clearTodos("completed");
    unsubscribe();

    // prevCount === 0 → nothing to brag about.
    expect(seen.find((e) => e.type === "todos_auto_cleared")).toBeUndefined();
  });
});

describe("Session TaskCreate tool_result — temp-id → real-id promotion", () => {
  // Regression guard for the live-session bug observed at session
  // `0976d610-7bf1-4c98-a839-6452a401b0bd`: the in-process TaskCreate
  // tool returns a PLAIN STRING (`"Task #1 created successfully: ..."`),
  // not JSON. The earlier implementation only called `JSON.parse` and
  // silently fell through to a catch — leaving the temp `tool_use_id`
  // in the snapshot. Every later `TaskUpdate {taskId: "1"}` then
  // mismatched and got dropped, leaving the user with "6 items, none
  // ever marked completed" even though the model emitted every status
  // transition correctly.
  function taskCreateAssistantEvent(
    uuid: string,
    toolUseId: string,
    subject: string,
    at: number,
  ): ServerEvent {
    return {
      type: "sdk",
      at,
      message: {
        type: "assistant",
        uuid,
        parent_tool_use_id: null,
        message: {
          id: uuid,
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: "TaskCreate",
              input: { subject, activeForm: subject },
            },
          ],
        },
      },
    } as unknown as ServerEvent;
  }

  function toolResultEvent(
    uuid: string,
    toolUseId: string,
    text: string,
    at: number,
  ): ServerEvent {
    return {
      type: "sdk",
      at,
      message: {
        type: "user",
        uuid,
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: text,
            },
          ],
        },
      },
    } as unknown as ServerEvent;
  }

  test("plain-string `Task #N created successfully:` promotes temp tool_use_id to real id", () => {
    const { internal } = makeSession();
    const tempId = "toolu_01H4SyuGgWBCSQHAZXsufEYx";
    internal.captureSnapshotState(
      taskCreateAssistantEvent("u-create", tempId, "Add git server helpers for branch ops", 1_000),
    );
    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({ id: tempId });

    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        tempId,
        "Task #1 created successfully: Add git server helpers for branch ops",
        2_000,
      ),
    );

    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "1",
      status: "pending",
    });
  });

  test("JSON `{task: {id}}` fallback still works for any future structured-result variant", () => {
    const { internal } = makeSession();
    const tempId = "toolu_FUTURE";
    internal.captureSnapshotState(
      taskCreateAssistantEvent("u-create", tempId, "do thing", 1_000),
    );
    internal.captureSnapshotState(
      toolResultEvent("u-result", tempId, JSON.stringify({ task: { id: "42" } }), 2_000),
    );
    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({ id: "42" });
  });

  test("after promotion, TaskUpdate by the real id flips the status", () => {
    const { internal } = makeSession();
    const tempId = "toolu_promoteme";
    internal.captureSnapshotState(taskCreateAssistantEvent("u-c", tempId, "a", 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-r", tempId, "Task #7 created successfully: a", 2_000),
    );

    // Model now marks the task completed via the real id.
    internal.captureSnapshotState(taskUpdateEvent("u-u", "7", "completed", 3_000));

    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "7",
      status: "completed",
    });
  });

  test("unparseable result leaves the temp-id entry in place (no crash)", () => {
    const { internal } = makeSession();
    const tempId = "toolu_garbage";
    internal.captureSnapshotState(taskCreateAssistantEvent("u-c", tempId, "x", 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-r", tempId, "this is neither JSON nor the canonical string", 2_000),
    );

    // Temp-id stays — degraded gracefully rather than corrupting state.
    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({ id: tempId });
  });
});

describe("Session.applyManualTodoOverrides", () => {
  test("reapplies persisted overrides on top of the replayed snapshot", () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent(
        "u-replay",
        [
          { id: "1", content: "a", status: "pending" },
          { id: "2", content: "b", status: "pending" },
          { id: "3", content: "c", status: "pending" },
        ],
        1_000,
      ),
    );

    // Simulate the `start()` step: load persisted overrides into memory.
    internal.manualTodoOverrides = {
      "1": "completed",
      "3": "deleted",
    };

    const applied = internal.applyManualTodoOverrides();

    expect(applied).toBe(2);
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "pending" },
    ]);
  });

  test("no-op when there are no overrides", () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-replay", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );

    expect(internal.applyManualTodoOverrides()).toBe(0);
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "a", status: "pending" },
    ]);
  });

  test("no-op when the snapshot is empty", () => {
    const { internal } = makeSession();
    internal.manualTodoOverrides = { "1": "completed" };

    expect(internal.applyManualTodoOverrides()).toBe(0);
    expect(internal.latestTodosSnapshot).toBeNull();
  });

  test("survives the start() replay path: load → replay → apply does NOT wipe the override", () => {
    // The load-bearing durability case the design exists for: server
    // restarts, override map loaded from disk, resume loop replays the
    // historical TodoWrite that originally created the item. Without the
    // `isReplayingTranscript` guard, the replay's clear-on-touch would
    // wipe the override BEFORE `applyManualTodoOverrides` had a chance
    // to use it — silently reverting every user click on restart.
    const { internal } = makeSession();
    // 1. Load persisted override (mirror what `start()` does on boot).
    internal.manualTodoOverrides = { "1": "completed" };
    // 2. Enter the replay window — this is the flag `start()` sets while
    //    draining historical events through `broadcast`.
    internal.isReplayingTranscript = true;
    // 3. Replay a historical TodoWrite that created the item with its
    //    original (pre-override) status.
    internal.captureSnapshotState(
      todoWriteEvent("u-hist", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );
    // 4. Leave the replay window — live events from here on clear normally.
    internal.isReplayingTranscript = false;

    // Override must still be present — replay-time clear-on-touch is a
    // bug, not a feature.
    expect(internal.manualTodoOverrides).toEqual({ "1": "completed" });

    // 5. Apply overrides on top of the replayed snapshot (the last step
    //    of `start()`).
    const applied = internal.applyManualTodoOverrides();
    expect(applied).toBe(1);
    expect((internal.latestTodosSnapshot ?? [])[0]).toMatchObject({
      id: "1",
      status: "completed",
    });
  });

  test("ignores overrides for ids the snapshot doesn't contain", () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(
      todoWriteEvent("u-replay", [{ id: "1", content: "a", status: "pending" }], 1_000),
    );
    internal.manualTodoOverrides = {
      "1": "completed",
      "ghost": "deleted",
    };

    const applied = internal.applyManualTodoOverrides();

    // Only the in-snapshot override counted.
    expect(applied).toBe(1);
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "a", status: "completed" },
    ]);
  });
});
