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
});
