import { describe, expect, test } from "vitest";
import { Session } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Coverage for the user-facing Clear-todos lever — the cutoff guards that
 * make a clear survive a server restart, and the always-broadcast rule
 * that fixes the "Clear button does nothing" symptom we shipped first.
 *
 * Two independent accumulators are at play here: the SERVER snapshot
 * (`latestTodosSnapshot`) and the CLIENT list (`latestTodos`, rebuilt from
 * the SSE stream of replayed `TodoWrite` / `TaskCreate` tool_use events).
 * The cutoff guard (`at >= latestTodosSnapshotAt`) tames the server side;
 * the synthetic post-replay `session_snapshot { todos: [] }` in
 * `subscribe()` tames the client side. This file pins the cutoff; the
 * cross-restart synthetic snapshot is exercised by the
 * `session-snapshot-state.test.ts` neighbour and the SSE integration paths.
 */

type SessionInternals = {
  latestTodosSnapshot: unknown[] | null;
  latestTodosSnapshotAt: number;
  captureSnapshotState: (event: ServerEvent) => void;
};

function makeSession(): SessionInternals {
  return new Session({ id: "clear-todos-test" }) as unknown as SessionInternals;
}

function todoEvent(uuid: string, todos: unknown[], at: number): ServerEvent {
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

function taskCreateEvent(
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

describe("Session todos cutoff guard", () => {
  test("rejects a replayed TodoWrite whose timestamp predates the clear marker", () => {
    const session = makeSession();
    // Prime with a live TodoWrite so we can prove the cutoff replaces it
    // rather than building over an empty state.
    const live = [{ id: "live", content: "live task", status: "in_progress" }];
    session.captureSnapshotState(todoEvent("a-live", live, 2_000));
    expect(session.latestTodosSnapshot).toEqual(live);

    // Simulate the durable clear: bump the cutoff to a wall-clock time
    // AFTER the live write — what `Session.start()` does when it reads
    // `todosClearedAt` from the JSON state bag before disk replay.
    session.latestTodosSnapshot = null;
    session.latestTodosSnapshotAt = 5_000;

    // Disk replay re-emits the historical TodoWrite with its original
    // JSONL timestamp (2_000), comfortably older than the cutoff. The
    // guard MUST reject it; otherwise the user's manual Clear would
    // silently resurrect on every server boot.
    session.captureSnapshotState(todoEvent("a-live", live, 2_000));
    expect(session.latestTodosSnapshot).toBeNull();
  });

  test("admits a TodoWrite whose timestamp is at or after the clear cutoff", () => {
    const session = makeSession();
    session.latestTodosSnapshot = null;
    session.latestTodosSnapshotAt = 5_000;

    const fresh = [{ id: "fresh", content: "post-clear task", status: "pending" }];
    session.captureSnapshotState(todoEvent("a-fresh", fresh, 6_000));

    expect(session.latestTodosSnapshot).toEqual(fresh);
  });

  test("rejects a replayed TaskCreate whose timestamp predates the clear marker", () => {
    const session = makeSession();
    // The `TaskCreate` branch is the preferred task-tool surface (the
    // `TodoWrite` branch is marked legacy in the code). Before the
    // symmetric cutoff fix, this path silently resurrected cleared items
    // on every server restart because `pendingTaskCreates` and the
    // snapshot both start empty in a fresh process — the dedup guards
    // alone don't catch a pre-clear entry that's never been seen.
    session.latestTodosSnapshot = null;
    session.latestTodosSnapshotAt = 5_000;

    session.captureSnapshotState(
      taskCreateEvent("a-pre", "task-id-1", "pre-clear task", 2_000),
    );

    expect(session.latestTodosSnapshot).toBeNull();
  });

  test("admits a TaskCreate whose timestamp is after the clear cutoff", () => {
    const session = makeSession();
    session.latestTodosSnapshot = null;
    session.latestTodosSnapshotAt = 5_000;

    session.captureSnapshotState(
      taskCreateEvent("a-post", "task-id-2", "post-clear task", 6_000),
    );

    expect(session.latestTodosSnapshot).toEqual([
      {
        id: "task-id-2",
        content: "post-clear task",
        status: "pending",
        activeForm: "post-clear task",
      },
    ]);
  });

  test("admits a TodoWrite stamped exactly at the clear cutoff (>= boundary)", () => {
    const session = makeSession();
    // The cutoff is inclusive — `at >= latestTodosSnapshotAt`. A tighter
    // exclusive boundary would lose the (rare but real) race where a
    // TodoWrite tool_use and a Clear land in the same millisecond; we
    // prefer to admit the write rather than risk a silent drop on a tie.
    session.latestTodosSnapshot = null;
    session.latestTodosSnapshotAt = 5_000;

    const tied = [{ id: "tied", content: "same-ms task", status: "pending" }];
    session.captureSnapshotState(todoEvent("a-tied", tied, 5_000));

    expect(session.latestTodosSnapshot).toEqual(tied);
  });
});
