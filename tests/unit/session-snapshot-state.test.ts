import { describe, expect, test } from "vitest";
import { Session } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Test-only view onto Session that exposes private members we need to
 * exercise directly (buffer, snapshot-derivation, etc.).
 *
 * IMPORTANT: this is *not* `Session & { ... }`. Intersecting a class with a
 * literal type when both declare a same-named property — and the class's
 * version is `private` — collapses the whole intersection to `never`
 * (TS2339 cascade: "Property X does not exist on type 'never'"). Defining
 * `SessionInternals` as a standalone shape and casting through `unknown`
 * sidesteps that. We re-export `subscribe` (the one public method the
 * tests touch) explicitly so we don't lose its signature.
 */
type SessionInternals = {
  buffer: ServerEvent[];
  bufferTrimmed: boolean;
  captureSnapshotState: (event: ServerEvent) => void;
  latestUserPromptSnapshot: { uuid: string; text: string; at?: number } | null;
  latestTodosSnapshot: unknown[] | null;
  lastCwdBroadcast: string | null;
  subscribe: Session["subscribe"];
};

function makeSession(): SessionInternals {
  return new Session({ id: "snapshot-test" }) as unknown as SessionInternals;
}

function userEvent(uuid: string, text: string, at: number): ServerEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "user",
      uuid,
      message: { content: [{ type: "text", text }] },
    },
  } as unknown as ServerEvent;
}

function editEvent(uuid: string, filePath: string, at: number): ServerEvent {
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
          { type: "tool_use", id: `tool-${uuid}`, name: "Edit", input: { file_path: filePath } },
        ],
      },
    },
  } as unknown as ServerEvent;
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

describe("Session derived snapshot state", () => {
  test("keeps the chronologically latest user prompt when older events arrive later", () => {
    const session = makeSession();

    session.captureSnapshotState(userEvent("u-new", "new prompt", 3_000));
    session.captureSnapshotState(userEvent("u-old", "old prompt", 1_000));

    expect(session.latestUserPromptSnapshot).toEqual({
      uuid: "u-new",
      text: "new prompt",
      at: 3_000,
    });
  });

  test("ignores the SDK post-compact continuation summary as a user prompt", () => {
    const session = makeSession();
    const summary =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: …";

    // A real prompt arrives first; the compact summary is the most recent
    // `user`-shaped record on resume. It must NOT overwrite the snapshot —
    // otherwise `session_snapshot` re-injects it into the chat as a user
    // bubble (the reported bug). The chat shows a compact_boundary divider
    // for the transition instead.
    session.captureSnapshotState(userEvent("u-real", "do the thing", 1_000));
    session.captureSnapshotState(userEvent("u-summary", summary, 2_000));

    expect(session.latestUserPromptSnapshot).toEqual({
      uuid: "u-real",
      text: "do the thing",
      at: 1_000,
    });
  });

  test("keeps the chronologically latest TodoWrite snapshot when older events arrive later", () => {
    const session = makeSession();
    const newerTodos = [{ id: "n", content: "new task", status: "in_progress" }];
    const olderTodos = [{ id: "o", content: "old task", status: "completed" }];

    session.captureSnapshotState(todoEvent("a-new", newerTodos, 3_000));
    session.captureSnapshotState(todoEvent("a-old", olderTodos, 1_000));

    expect(session.latestTodosSnapshot).toEqual(newerTodos);
  });

  test("reports older history when replay starts at the head of a trimmed buffer", () => {
    const session = makeSession();
    session.buffer = [userEvent("u-retained", "retained prompt", 3_000)];
    session.bufferTrimmed = true;

    const events: ServerEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event), { tail: 20 });
    unsubscribe();

    expect(events).toContainEqual({ type: "replay_done", hasMoreAbove: true });
  });

  test("derives the effective worktree cwd from a replayed mutating-file tool_use", () => {
    const session = makeSession();
    // A server restart rebuilds the session from its JSONL; the live
    // PreToolUse hook doesn't re-fire, so this disk-replay path is the only
    // thing that can re-flag the worktree. The Edit's path lives under
    // `.claude/worktrees/<name>/`, which `worktreeRootFromPath` recognizes.
    session.captureSnapshotState(
      editEvent("a1", "/proj/.claude/worktrees/feature-x/lib/foo.ts", 1_000),
    );

    expect(session.lastCwdBroadcast).toBe("/proj/.claude/worktrees/feature-x");
  });

  test("ignores edits that don't live under a worktree", () => {
    const session = makeSession();
    session.captureSnapshotState(editEvent("a1", "/proj/lib/foo.ts", 1_000));

    expect(session.lastCwdBroadcast).toBeNull();
  });

  test("re-emits the worktree cwd on subscribe even after the buffered event was trimmed", () => {
    const session = makeSession();
    // Flag the worktree via the disk-replay sniffer (which broadcasts a
    // `cwd_changed` into the buffer as a side effect).
    session.captureSnapshotState(
      editEvent("a1", "/proj/.claude/worktrees/feature-x/lib/foo.ts", 1_000),
    );
    // Simulate the long-session reality the badge bug hits: the single
    // `cwd_changed` broadcast has aged out of the 1000-event buffer cap, so a
    // late subscriber (reload / second tab) wouldn't see it from the replay.
    session.buffer = [];
    session.bufferTrimmed = true;

    const events: ServerEvent[] = [];
    session.subscribe((event) => events.push(event))();

    // The badge is rescued by the in-memory `lastCwdBroadcast` re-emit, not
    // the (now-trimmed) buffered event.
    expect(events).toContainEqual({
      type: "cwd_changed",
      cwd: "/proj/.claude/worktrees/feature-x",
    });
  });
});
