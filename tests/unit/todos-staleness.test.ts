import { describe, expect, test } from "vitest";

import { Session, todosMidTurnReminderBody } from "@/lib/server/session";
import {
  midTurnReminderCount,
  takeMidTurnReminders,
} from "@/lib/server/system-reminders";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Progress-based + mid-turn to-do staleness — the in-session fix for two
 * reported failures the 24h wall-clock clear (resume-only) never caught:
 *
 *   1. Abandonment: model emits a list once, never touches it again → "0/N"
 *      sits forever.
 *   2. Runaway / churn: model keeps ADDING items (the 0/26-and-growing
 *      screenshot) but never marks anything completed.
 *
 * Both are caught by counting consecutive turns with open items and NO
 * completion PROGRESS (more items done, or the list pruned). A naive "did the
 * model touch the list" signal would reset on every add and let the runaway
 * list grow unbounded — so progress, not touch, drives the counter:
 *
 *   - At `TODOS_STALE_FLAG_TURNS` (3) no-progress turns → flag stale
 *     (`todosStale=true`, broadcast for the UI badge); list intact.
 *   - At `TODOS_STALE_CLEAR_TURNS` (6) → auto-clear.
 *   - Any real progress resets the counter and un-stales.
 *
 * Mid-turn: once the model takes `TODOS_MIDTURN_TOOLUSE_THRESHOLD` non-todo
 * actions with an OPEN list and no touch, a one-shot mid-turn reminder is
 * queued. Gated on open items, live-only, once per turn.
 *
 * Drives the private `captureSnapshotState` / `maybeAutoSyncTodosOnTurnEnd`
 * directly (same harness shape as `todos-turn-end-sync.test.ts`).
 */

type SessionInternals = {
  latestTodosSnapshot: unknown[] | null;
  todosStale: boolean;
  toolUsesSinceTodoTouch: number;
  turnsTodosNoProgress: number;
  isReplayingTranscript: boolean;
  captureSnapshotState: (event: ServerEvent) => void;
  maybeAutoSyncTodosOnTurnEnd: () => Promise<void>;
};

function makeSession(): { internal: SessionInternals; raw: Session } {
  const raw = new Session({ id: "todos-staleness-test" });
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

/** A generic non-todo tool_use (Bash) — counts as a mid-turn "action". */
function bashEvent(uuid: string, at: number): ServerEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        id: uuid,
        content: [{ type: "tool_use", id: `tool-${uuid}`, name: "Bash", input: { command: "ls" } }],
      },
    },
  } as unknown as ServerEvent;
}

/** `n` pending items, the first `done` of them marked completed. */
function todos(n: number, done = 0): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    content: `item ${i + 1}`,
    status: i < done ? "completed" : "pending",
  }));
}

const OPEN_TODOS = todos(2);

describe("todosMidTurnReminderBody", () => {
  test("cites the mark-completed and prune verbs and is NOT softened", () => {
    const body = todosMidTurnReminderBody(OPEN_TODOS);
    expect(body).toContain("You've taken several actions without updating the to-do list");
    expect(body).toContain('status "completed"');
    expect(body).toContain('status="deleted"');
    expect(body).not.toContain("ignore if not applicable");
    expect(body).toContain("Current todos:");
    expect(body).toContain('"id": "1"');
  });

  test("omits the JSON dump on an empty list", () => {
    const body = todosMidTurnReminderBody([]);
    expect(body).not.toContain("Current todos");
  });
});

describe("progress-based staleness — flag then auto-clear", () => {
  test("a list that makes no progress flags at FLAG turns and clears at CLEAR turns", async () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-0", OPEN_TODOS, 1_000));

    // Turns 1, 2: open, no progress → counter climbs, under the flag.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(1);
    expect(internal.todosStale).toBe(false);
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(2);
    expect(internal.todosStale).toBe(false);

    // Turn 3 → flag stale, list still intact.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(3);
    expect(internal.todosStale).toBe(true);
    expect(internal.latestTodosSnapshot).not.toBeNull();

    // Turns 4, 5 → still flagged, still intact.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).not.toBeNull();

    // Turn 6 → auto-cleared.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).toBeNull();
    expect(internal.todosStale).toBe(false);
  });

  test("RUNAWAY: a list the model keeps GROWING without completing anything still goes stale", async () => {
    // The 0/26-and-growing screenshot. The model touches the list every turn
    // (adds items) — a touch-based signal would never flag it. Progress-based
    // detection sees done stay at 0 while total only grows, so it climbs.
    const { internal } = makeSession();

    // Turn 1: 2 items. Turn 2: 4 items. Turn 3: 6 items. None completed.
    internal.captureSnapshotState(todoWriteEvent("u-1", todos(2), 1_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(1);

    internal.captureSnapshotState(todoWriteEvent("u-2", todos(4), 2_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(2);

    internal.captureSnapshotState(todoWriteEvent("u-3", todos(6), 3_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(3);
    // Growing + never completing → flagged stale despite every-turn touches.
    expect(internal.todosStale).toBe(true);

    // Keep growing — eventually auto-cleared.
    internal.captureSnapshotState(todoWriteEvent("u-4", todos(8), 4_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    internal.captureSnapshotState(todoWriteEvent("u-5", todos(10), 5_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    internal.captureSnapshotState(todoWriteEvent("u-6", todos(12), 6_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).toBeNull();
  });

  test("completing an item is PROGRESS — resets the counter and un-stales", async () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-0", todos(3), 1_000));
    // Push to stale (3 no-progress turns).
    await internal.maybeAutoSyncTodosOnTurnEnd();
    await internal.maybeAutoSyncTodosOnTurnEnd();
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.todosStale).toBe(true);

    // Model marks one item completed → progress → un-stale, counter reset.
    internal.captureSnapshotState(todoWriteEvent("u-done", todos(3, 1), 2_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(0);
    expect(internal.todosStale).toBe(false);
  });

  test("pruning the list (it shrinks) is PROGRESS — resets the counter", async () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-0", todos(4), 1_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(2);

    // Model prunes 4 → 2 items (still nothing completed) — list management
    // counts as progress.
    internal.captureSnapshotState(todoWriteEvent("u-prune", todos(2), 2_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.turnsTodosNoProgress).toBe(0);
  });

  test("an all-completed list never flags stale (it auto-clears instead)", async () => {
    const { internal } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-done", todos(2, 2), 1_000));
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).toBeNull();
    expect(internal.todosStale).toBe(false);
  });
});

describe("mid-turn staleness reminder", () => {
  test("fires once after TODOS_MIDTURN_TOOLUSE_THRESHOLD non-todo actions with an open list", () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-0", OPEN_TODOS, 1_000));
    expect(internal.toolUsesSinceTodoTouch).toBe(0);

    for (let i = 0; i < 12; i++) {
      internal.captureSnapshotState(bashEvent(`b-${i}`, 2_000 + i));
    }
    expect(midTurnReminderCount(raw)).toBe(1);

    // More actions don't re-fire — once per turn.
    internal.captureSnapshotState(bashEvent("b-extra", 9_999));
    expect(midTurnReminderCount(raw)).toBe(1);

    const drained = takeMidTurnReminders(raw);
    expect(drained).toContain("You've taken several actions without updating");
    expect(drained).toContain("<system-reminder>");
  });

  test("does NOT fire when there is no open list (no noise)", () => {
    const { internal, raw } = makeSession();
    for (let i = 0; i < 20; i++) {
      internal.captureSnapshotState(bashEvent(`b-${i}`, 1_000 + i));
    }
    expect(midTurnReminderCount(raw)).toBe(0);
  });

  test("does NOT fire when every item is completed (nothing to remind about)", () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-done", todos(1, 1), 1_000));
    for (let i = 0; i < 20; i++) {
      internal.captureSnapshotState(bashEvent(`b-${i}`, 2_000 + i));
    }
    expect(midTurnReminderCount(raw)).toBe(0);
  });

  test("does NOT fire during disk replay", () => {
    const { internal, raw } = makeSession();
    internal.captureSnapshotState(todoWriteEvent("u-0", OPEN_TODOS, 1_000));
    internal.isReplayingTranscript = true;
    for (let i = 0; i < 20; i++) {
      internal.captureSnapshotState(bashEvent(`b-${i}`, 2_000 + i));
    }
    expect(midTurnReminderCount(raw)).toBe(0);
  });
});
