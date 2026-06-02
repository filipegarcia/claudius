import { describe, expect, test } from "vitest";

import { Session, todosCurrentReminderBody } from "@/lib/server/session";
import { pendingReminderCount, takePendingReminders } from "@/lib/server/system-reminders";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Turn-end to-do synchronization. Two honest tiers wired into the
 * `consume()` `result` handler (gated on `subtype: "success"`):
 *
 *   1. ALL-COMPLETED auto-clear: every snapshot item is `completed` →
 *      `clearTodos("completed")` drops the list. No fabrication; the
 *      model itself produced the `completed` status.
 *
 *   2. PER-TURN AWARENESS: open items remain → queue a one-shot
 *      `todos-current` reminder for the next user turn dumping the live
 *      list. Fires every turn (no cadence threshold), per Claude Code
 *      parity: keep the model aware of the list as part of its working
 *      context. The `todosTouchedThisTurn` flag is rearmed at turn end
 *      so a disk-replay path can't leak `true` into the first live turn.
 *
 * We deliberately do NOT auto-delete unfinished items: only the model
 * knows whether a todo is abandoned or paused. The 24h staleness clear
 * in `start()` still catches truly abandoned sessions, the manual Clear
 * button wins for "this list is dead now," and per-item user controls
 * (`updateTodoItem`) cover targeted manual mutation.
 *
 * Pure-helper prose lives in `todosCurrentReminderBody`; integration is
 * exercised by driving the private `maybeAutoSyncTodosOnTurnEnd` +
 * `captureSnapshotState` from this test harness so we avoid spinning up
 * the SDK loop (same shape as `clear-todos.test.ts`).
 */

type SessionInternals = {
  latestTodosSnapshot: unknown[] | null;
  latestTodosSnapshotAt: number;
  todosTouchedThisTurn: boolean;
  captureSnapshotState: (event: ServerEvent) => void;
  maybeAutoSyncTodosOnTurnEnd: () => Promise<void>;
};

function makeSession(): { internal: SessionInternals; raw: Session } {
  const raw = new Session({ id: "todos-turn-end-test" });
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

function taskCreateEvent(uuid: string, toolUseId: string, subject: string, at: number): ServerEvent {
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

describe("todosCurrentReminderBody", () => {
  test("emits the per-turn awareness prose for an empty list", () => {
    const body = todosCurrentReminderBody([]);
    // Anchor lines: the body must cite both the mark-completed and the
    // prune-via-deleted affordances so the model has a clear verb set.
    expect(body).toContain("The current to-do list for this session is shown below");
    expect(body).toContain('status "completed"');
    expect(body).toContain('status="deleted"');
    // No "ignore if not applicable" softener — that phrasing empirically
    // gave the model permission to ignore the reminder, which is exactly
    // what the prior 0/N failure mode looked like.
    expect(body).not.toContain("ignore if not applicable");
    expect(body).not.toContain("Current todos");
  });

  test("appends a JSON dump of the current todos when the list is non-empty", () => {
    const todos = [
      { id: "1", content: "do the thing", status: "pending" },
      { id: "2", content: "fix the bug", status: "in_progress" },
    ];
    const body = todosCurrentReminderBody(todos);
    expect(body).toContain("Current todos:");
    expect(body).toContain('"id": "1"');
    expect(body).toContain('"status": "in_progress"');
  });
});

describe("Session turn-end todo sync — all-completed auto-clear", () => {
  test("clears the snapshot when every item is completed", async () => {
    const { internal } = makeSession();
    const todos = [
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "completed" },
    ];
    internal.captureSnapshotState(todoWriteEvent("u-1", todos, 1_000));
    expect(internal.latestTodosSnapshot).toEqual(todos);

    await internal.maybeAutoSyncTodosOnTurnEnd();

    // clearTodos nulls the snapshot and bumps the cutoff to wall-clock.
    // The cutoff side is exercised by clear-todos.test.ts; here we only
    // need to confirm the auto-sync reached for clearTodos at all.
    expect(internal.latestTodosSnapshot).toBeNull();
  });

  test("no-op on an empty snapshot — `[].every` is true but length=0 guards it", async () => {
    const { internal, raw } = makeSession();
    // Fresh session: snapshot null, no events.
    expect(internal.latestTodosSnapshot).toBeNull();

    await internal.maybeAutoSyncTodosOnTurnEnd();

    expect(internal.latestTodosSnapshot).toBeNull();
    // And no reminder queued — the body has nothing to surface.
    expect(pendingReminderCount(raw)).toBe(0);
  });

  test("does not clear when at least one item is still pending", async () => {
    const { internal } = makeSession();
    const todos = [
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "pending" },
    ];
    internal.captureSnapshotState(todoWriteEvent("u-mixed", todos, 1_000));

    await internal.maybeAutoSyncTodosOnTurnEnd();

    // Snapshot intact — the model still has work to do; we never silently
    // delete pending items.
    expect(internal.latestTodosSnapshot).toEqual(todos);
  });
});

describe("Session turn-end todo sync — per-turn awareness", () => {
  test("queues a `todos-current` reminder every turn the snapshot has open items", async () => {
    const { internal, raw } = makeSession();
    const todos = [
      { id: "1", content: "still doing this", status: "pending" },
      { id: "2", content: "in flight", status: "in_progress" },
    ];
    internal.captureSnapshotState(todoWriteEvent("u-prev", todos, 1_000));

    // First turn end → reminder queued. No cadence threshold any more —
    // the per-turn awareness is the design.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(pendingReminderCount(raw)).toBe(1);

    // Snapshot untouched — we never silently delete unfinished work; the
    // awareness path is advisory, not destructive.
    expect(internal.latestTodosSnapshot).toEqual(todos);

    const drained = takePendingReminders(raw);
    expect(drained).toContain("The current to-do list for this session is shown below");
    expect(drained).toContain('status "completed"');
    expect(drained).toContain('status="deleted"');
    expect(drained).toContain("Current todos:");
    // Wrapped in the canonical reminder tag so `cleanReminders` strips it
    // downstream.
    expect(drained).toContain("<system-reminder>");
    expect(drained).toContain("</system-reminder>");
  });

  test("queues again on the next turn — per-turn awareness is periodic, not one-shot", async () => {
    const { internal, raw } = makeSession();
    const todos = [{ id: "1", content: "ongoing", status: "pending" }];
    internal.captureSnapshotState(todoWriteEvent("u-init", todos, 1_000));

    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(pendingReminderCount(raw)).toBe(1);
    takePendingReminders(raw);

    // No model activity. Second turn end → reminder queued again. Old
    // cadence design required 3 silent turns; new design fires every turn.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(pendingReminderCount(raw)).toBe(1);
  });

  test("queues a reminder even when the agent touched the list this turn — keeps the list resident", async () => {
    // The prior cadence design suppressed the reminder when the agent
    // already touched the list. With per-turn awareness as the goal, the
    // reminder fires regardless: a fresh snapshot dump every turn is
    // exactly what we want for Claude Code parity (the rewritten list is
    // already in context via the tool_use, but the system-reminder
    // anchors the model's attention on the live state for the next
    // assistant turn). Both signals on top of each other are fine; this
    // is the SAME content the model just wrote, not new pressure.
    const { internal, raw } = makeSession();
    const todos = [{ id: "1", content: "work item", status: "pending" }];
    internal.captureSnapshotState(todoWriteEvent("u-now", todos, 1_000));
    expect(internal.todosTouchedThisTurn).toBe(true);

    await internal.maybeAutoSyncTodosOnTurnEnd();

    expect(pendingReminderCount(raw)).toBe(1);
  });

  test("rearms `todosTouchedThisTurn` at turn end so disk-replay state doesn't bleed into the first live turn", async () => {
    const { internal } = makeSession();
    // Simulate replay landing a TaskCreate that set the touched flag.
    internal.captureSnapshotState(taskCreateEvent("u-replay", "task-1", "from disk", 1_000));
    expect(internal.todosTouchedThisTurn).toBe(true);

    await internal.maybeAutoSyncTodosOnTurnEnd();

    // Flag must be cleared so the next live turn starts honestly.
    expect(internal.todosTouchedThisTurn).toBe(false);
  });

  test("does NOT queue a reminder when the snapshot is empty (nothing to surface)", async () => {
    const { internal, raw } = makeSession();
    internal.todosTouchedThisTurn = false;

    await internal.maybeAutoSyncTodosOnTurnEnd();

    expect(pendingReminderCount(raw)).toBe(0);
  });
});
