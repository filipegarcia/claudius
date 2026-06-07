import { describe, expect, test } from "vitest";
import { Session } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";
import { parseTaskListResult } from "@/lib/shared/parse-tasklist-result";

/**
 * Regression guard for the live-session bug observed in session a31d05a5
 * (advisor-feature work, June 7 2026): the user looked at the rail's
 * To-dos section, saw "(0) No tasks yet", and asked the model to mark
 * them done. The model called `TaskList` → the SDK returned all 15 tasks
 * already in `[completed]` status → the model called `TaskUpdate` on each
 * → declared "All 15 tasks are now marked completed". From the model's
 * point of view this was correct (the SDK task store was up to date),
 * but the rail still showed (0) because:
 *
 *   - `clearTodos()` had previously nulled `latestTodosSnapshot` (the
 *     "completed" stop-reason auto-clear, the staleness auto-clear, or a
 *     manual Clear button click — `.claudius.db` for that session shows
 *     `state.todosClearedAt`).
 *   - `captureSnapshotState`'s `TaskUpdate` branch is gated on
 *     `&& this.latestTodosSnapshot` (session.ts:5544 pre-fix), so every
 *     subsequent TaskUpdate was silently dropped.
 *   - Nothing observed `TaskList` tool_results, so the rail had no path
 *     back from the SDK's source of truth.
 *
 * Fix: register `TaskList` tool_use_ids in `pendingTaskLists`, parse the
 * result text, replace the snapshot, re-apply manual overrides. Any
 * future TaskList call self-heals the rail.
 */

type SessionInternals = {
  latestTodosSnapshot: unknown[] | null;
  latestTodosSnapshotAt: number;
  manualTodoOverrides: Record<string, "completed" | "pending" | "in_progress" | "deleted">;
  isReplayingTranscript: boolean;
  todosRebuiltFromTaskListThisTurn: boolean;
  captureSnapshotState: (event: ServerEvent) => void;
  maybeAutoSyncTodosOnTurnEnd: () => Promise<void>;
};

function makeSession(): { internal: SessionInternals; raw: Session } {
  const raw = new Session({ id: "tasklist-rebuilds-snapshot-test" });
  return { internal: raw as unknown as SessionInternals, raw };
}

function taskListAssistantEvent(
  uuid: string,
  toolUseId: string,
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
            name: "TaskList",
            input: {},
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
  isError = false,
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
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    },
  } as unknown as ServerEvent;
}

// Verbatim TaskList result text from session a31d05a5's JSONL — captured
// from `~/.claude/projects/<proj>/a31d05a5-…jsonl` line 945. If the SDK
// output format shifts, this is the failing fixture that will catch it
// rather than silently letting the rail desync forever.
const A31D05A5_TASKLIST_RESULT = `#1 [completed] Add shared advisor constants module
#2 [completed] Forward advisorModel from settings.json to SDK at session start
#3 [completed] Add per-session setAdvisorModel + API route
#4 [completed] Plumb advisorModel through use-session.ts
#5 [completed] Add advisor section to ModelPicker + advisor badge to SessionCard
#6 [completed] Wire SessionCard call sites + render verbatim message in settings page
#7 [completed] Run lint on changed files
#8 [completed] Seed client advisorModel from server on session bind
#9 [completed] Diagnose why pre-existing advisor config didn't show up
#10 [completed] Check /advisor slash-command behavior in the SDK
#11 [completed] Clarify advisor scope — connection-level, not session-only
#12 [completed] Make advisor persist globally + GET fall back to settings.json
#13 [completed] Add e2e spec for the advisor picker
#14 [completed] Show advisor badge for any value + use init.tools as source of truth
#15 [completed] Add client-side /advisor synthetic command`;

describe("parseTaskListResult", () => {
  test("parses the verbatim a31d05a5 TaskList result text", () => {
    const parsed = parseTaskListResult(A31D05A5_TASKLIST_RESULT);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(15);
    expect(parsed![0]).toEqual({
      id: "1",
      content: "Add shared advisor constants module",
      status: "completed",
    });
    expect(parsed![14]).toEqual({
      id: "15",
      content: "Add client-side /advisor synthetic command",
      status: "completed",
    });
  });

  test("mixed statuses parse with the verbatim bracketed token", () => {
    const text = `#1 [pending] do thing
#2 [in_progress] doing other thing
#3 [completed] done thing`;
    const parsed = parseTaskListResult(text);
    expect(parsed).toEqual([
      { id: "1", content: "do thing", status: "pending" },
      { id: "2", content: "doing other thing", status: "in_progress" },
      { id: "3", content: "done thing", status: "completed" },
    ]);
  });

  test("non-numeric ids survive (future SDK slug ids)", () => {
    const text = `#abc-123 [pending] do thing`;
    const parsed = parseTaskListResult(text);
    expect(parsed).toEqual([
      { id: "abc-123", content: "do thing", status: "pending" },
    ]);
  });

  test("empty string returns [] (caller wipes the snapshot)", () => {
    expect(parseTaskListResult("")).toEqual([]);
    expect(parseTaskListResult("   \n  \n  ")).toEqual([]);
  });

  test("null / undefined returns null (caller leaves snapshot alone)", () => {
    expect(parseTaskListResult(null)).toBeNull();
    expect(parseTaskListResult(undefined)).toBeNull();
  });

  test("unknown shape returns null (fail open — better stale than empty)", () => {
    // Non-matching but non-empty text: SDK output format changed under us,
    // we don't know what to do, leave snapshot intact.
    expect(parseTaskListResult("totally unexpected output")).toBeNull();
    expect(parseTaskListResult("Tasks:\n  - 1: do thing")).toBeNull();
  });

  test("ignores garbage lines mixed in with valid ones", () => {
    const text = `random preamble
#1 [pending] do thing
some other line
#2 [completed] done`;
    const parsed = parseTaskListResult(text);
    expect(parsed).toEqual([
      { id: "1", content: "do thing", status: "pending" },
      { id: "2", content: "done", status: "completed" },
    ]);
  });
});

describe("Session captureSnapshotState — TaskList rebuilds the snapshot", () => {
  test("rebuilds a null snapshot from a TaskList result (the a31d05a5 desync)", () => {
    const { internal } = makeSession();
    // Simulate the post-clearTodos state: snapshot is null, cutoff is set
    // to some prior time. (clearTodos uses `Date.now()`; we use a static
    // value so the test isn't timing-dependent.)
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_01F4ZMdND9CPkFQDnzWZ1sva";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, A31D05A5_TASKLIST_RESULT, 1_000),
    );

    // Re-read after the captureSnapshotState calls. The annotation is so TS
    // re-widens the type — without it TS keeps the `null` narrowing from the
    // assignment above and snap!.length becomes `never.length`.
    const snap: unknown[] | null = internal.latestTodosSnapshot;
    expect(snap).not.toBeNull();
    expect(snap!.length).toBe(15);
    expect((snap![0] as { id: unknown }).id).toBe("1");
    expect((snap![14] as { id: unknown }).id).toBe("15");
    expect((snap![0] as { status: unknown }).status).toBe("completed");
  });

  test("replaces an existing snapshot wholesale", () => {
    const { internal } = makeSession();
    // Pre-populate the snapshot with stale rail state — what the rail
    // might still hold from a TaskCreate burst earlier in the session.
    internal.latestTodosSnapshot = [
      { id: "old1", content: "stale row", status: "pending" },
    ];
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_TL2";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, `#1 [pending] fresh row`, 1_000),
    );

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "fresh row", status: "pending" },
    ]);
  });

  test("active manual overrides survive the rebuild", () => {
    const { internal } = makeSession();
    // The user has a pending-side override on id "2" (e.g. marked
    // delete locally before the model engaged).
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;
    internal.manualTodoOverrides = { "2": "deleted" };

    const toolUseId = "toolu_TL3";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        toolUseId,
        `#1 [completed] a\n#2 [completed] b\n#3 [completed] c`,
        1_000,
      ),
    );

    // Same widening trick as the test above — TS still thinks the property
    // is `null` after the `= null` setup line; the explicit annotation lets
    // the runtime-narrowed cast below typecheck.
    const snap: unknown[] | null = internal.latestTodosSnapshot;
    expect(snap).not.toBeNull();
    // id "2" should be filtered out by the persisted "deleted" override.
    expect((snap! as Array<{ id: string }>).map((t) => t.id)).toEqual(["1", "3"]);
  });

  test("is_error result is dropped — leaves the snapshot alone", () => {
    const { internal } = makeSession();
    internal.latestTodosSnapshot = [
      { id: "1", content: "keep me", status: "pending" },
    ];
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_TL_err";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, "stack trace gibberish", 1_000, true),
    );

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "keep me", status: "pending" },
    ]);
  });

  test("unparseable text leaves the snapshot alone (fail open)", () => {
    const { internal } = makeSession();
    internal.latestTodosSnapshot = [
      { id: "1", content: "keep me", status: "pending" },
    ];
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_TL_garbage";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, "Tasks:\n - 1: do thing\n", 1_000),
    );

    // Unknown shape → no replacement (better stale than empty).
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "keep me", status: "pending" },
    ]);
  });

  test("empty TaskList result wipes the snapshot (SDK store really is empty)", () => {
    const { internal } = makeSession();
    internal.latestTodosSnapshot = [
      { id: "1", content: "drop me", status: "pending" },
    ];
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_TL_empty";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, "", 1_000),
    );

    expect(internal.latestTodosSnapshot).toEqual([]);
  });

  test("cutoff guard — disk-replay of a pre-clear TaskList does NOT resurrect cleared list", () => {
    const { internal } = makeSession();
    // Simulate `start()` after a server restart: the resume path seeded
    // `latestTodosSnapshotAt` from the persisted `todosClearedAt` so
    // every pre-clear entry in the JSONL gets bounced. The cutoff is in
    // the FUTURE relative to the TaskList timestamp we're about to
    // replay.
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 5_000;

    const toolUseId = "toolu_replay_pre_clear";
    // Pre-clear TaskList tool_use + result, both at `at = 1_000` (before
    // the seeded cutoff). Without the guard this would unconditionally
    // resurrect the cleared list on every restart.
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        toolUseId,
        `#1 [completed] resurrected stale row`,
        1_000,
      ),
    );

    // Snapshot must remain null — the cutoff bounced the pre-clear
    // result the same way the TaskCreate branch does (line 5512).
    expect(internal.latestTodosSnapshot).toBeNull();
  });

  test("post-clear LIVE TaskList still rebuilds (its `at` beats the cutoff)", () => {
    const { internal } = makeSession();
    // Live case: clear happened at t=5_000, the user then asked "what
    // tasks?" and the model called TaskList at t=10_000. The result
    // timestamp is AHEAD of the cutoff, so the rebuild applies.
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 5_000;

    const toolUseId = "toolu_post_clear_live";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 10_000));
    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        toolUseId,
        `#1 [completed] real live row`,
        10_000,
      ),
    );

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "real live row", status: "completed" },
    ]);
  });

  test("TaskList rebuild sets `todosRebuiltFromTaskListThisTurn`", () => {
    const { internal } = makeSession();
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;
    expect(internal.todosRebuiltFromTaskListThisTurn).toBe(false);

    const toolUseId = "toolu_flag_set";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, `#1 [completed] x`, 1_000),
    );

    expect(internal.todosRebuiltFromTaskListThisTurn).toBe(true);
  });

  test("TaskUpdate AFTER a TaskList rebuild applies normally (end-to-end heal)", () => {
    const { internal } = makeSession();
    // Post-clear state.
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;

    const listToolUseId = "toolu_TL_then_update";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", listToolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        listToolUseId,
        `#1 [pending] do thing\n#2 [pending] do other`,
        1_000,
      ),
    );

    // Snapshot is now populated — TaskUpdate should land normally.
    internal.captureSnapshotState({
      type: "sdk",
      at: 2_000,
      message: {
        type: "assistant",
        uuid: "u-update",
        parent_tool_use_id: null,
        message: {
          id: "u-update",
          content: [
            {
              type: "tool_use",
              id: "toolu_update",
              name: "TaskUpdate",
              input: { taskId: "1", status: "completed" },
            },
          ],
        },
      },
    } as unknown as ServerEvent);

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "do thing", status: "completed" },
      { id: "2", content: "do other", status: "pending" },
    ]);
  });
});

describe("maybeAutoSyncTodosOnTurnEnd — TaskList-rebuilt snapshot survives one turn", () => {
  // The all-completed auto-clear (`clearTodos("completed")` in
  // `maybeAutoSyncTodosOnTurnEnd`) is the user's stated desired behavior
  // for the normal "model finished everything" flow. But on the bug-report
  // path (user explicitly asks "what tasks?" → TaskList rebuilds the
  // snapshot to 15 [completed]), letting the auto-clear fire on the SAME
  // turn would wipe the rail immediately — same (0) screenshot, fix
  // defeated. The `todosRebuiltFromTaskListThisTurn` flag suppresses the
  // auto-clear for ONE turn so the user actually sees the rebuilt list;
  // subsequent turns re-arm normally.

  test("all-completed AUTO-CLEAR is suppressed when this turn rebuilt from TaskList", async () => {
    const { internal, raw } = makeSession();
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_suppress";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent(
        "u-result",
        toolUseId,
        `#1 [completed] a\n#2 [completed] b`,
        1_000,
      ),
    );
    expect(internal.todosRebuiltFromTaskListThisTurn).toBe(true);

    // Simulate the turn-end auto-sync. The snapshot is all-completed,
    // which would normally trip `clearTodos("completed")` — but the
    // rebuild flag should suppress it for this turn.
    await internal.maybeAutoSyncTodosOnTurnEnd();

    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "completed" },
    ]);
    // And the flag should have been rearmed for the NEXT turn.
    expect(internal.todosRebuiltFromTaskListThisTurn).toBe(false);
    // Quiet a TS-internal unused warning on the wrapper.
    void raw;
  });

  test("all-completed auto-clear DOES fire on the NEXT turn (no further TaskList)", async () => {
    const { internal } = makeSession();
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;

    const toolUseId = "toolu_second_turn";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, `#1 [completed] a`, 1_000),
    );
    // First turn end — suppressed.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).not.toBeNull();

    // Second turn end — no further TaskList, flag is false, the auto-
    // clear should fire as the user explicitly asked it to keep doing.
    await internal.maybeAutoSyncTodosOnTurnEnd();
    expect(internal.latestTodosSnapshot).toBeNull();
  });

  test("replay-bleed guard — TaskList during disk replay does NOT set the flag", () => {
    // Hazard: `start()`'s resume loop replays every JSONL tool_use /
    // tool_result through `captureSnapshotState` with
    // `isReplayingTranscript = true`. `maybeAutoSyncTodosOnTurnEnd`
    // doesn't run during replay, so if the TaskList branch unconditionally
    // sets `todosRebuiltFromTaskListThisTurn`, the flag survives into the
    // first LIVE turn and suppresses a legitimate all-completed auto-
    // clear — same shape of bleed-across-replay the codebase already
    // guards `todosTouchedThisTurn` for.
    const { internal } = makeSession();
    internal.latestTodosSnapshot = null;
    internal.latestTodosSnapshotAt = 500;
    internal.isReplayingTranscript = true;

    const toolUseId = "toolu_replay_post_clear";
    internal.captureSnapshotState(taskListAssistantEvent("u-list", toolUseId, 1_000));
    internal.captureSnapshotState(
      toolResultEvent("u-result", toolUseId, `#1 [completed] x`, 1_000),
    );

    // Snapshot rebuild still happens (the result IS authoritative state
    // from the SDK store, replay just means we're reading it off disk).
    expect(internal.latestTodosSnapshot).toEqual([
      { id: "1", content: "x", status: "completed" },
    ]);
    // But the suppression flag MUST stay false so the first live
    // all-completed turn-end still clears as the user asked.
    expect(internal.todosRebuiltFromTaskListThisTurn).toBe(false);
  });

  test("auto-clear still fires when snapshot was NOT rebuilt from TaskList this turn", async () => {
    const { internal } = makeSession();
    // Snapshot reached all-completed via TaskUpdate, not TaskList. The
    // user's desired auto-clear path — fire normally.
    internal.latestTodosSnapshot = [
      { id: "1", content: "x", status: "completed" },
      { id: "2", content: "y", status: "completed" },
    ];
    internal.latestTodosSnapshotAt = 1_000;
    internal.todosRebuiltFromTaskListThisTurn = false;

    await internal.maybeAutoSyncTodosOnTurnEnd();

    expect(internal.latestTodosSnapshot).toBeNull();
  });
});
