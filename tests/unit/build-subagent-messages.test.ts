import { describe, expect, test } from "vitest";
import { buildSubagentMessages } from "@/lib/client/use-session";

/**
 * `buildSubagentMessages` rebuilds a subagent's transcript from the raw SDK
 * envelopes persisted server-side and replayed via the `task_snapshot` event.
 * It must mirror the live subagent reducer: coalesce multi-block assistant
 * splits (shared `message.id`) into one bubble, render user messages as text,
 * tag everything with the parent Task tool_use id, and never leave a replayed
 * bubble stuck in the streaming state.
 */

const PARENT = "toolu_parent";

function assistant(uuid: string, messageId: string, content: unknown, at?: number) {
  return { at, message: { type: "assistant", uuid, message: { id: messageId, content } } };
}

function user(uuid: string, content: unknown, at?: number) {
  return { at, message: { type: "user", uuid, message: { content } } };
}

describe("buildSubagentMessages", () => {
  test("rebuilds an assistant bubble with parent tag and no streaming flag", () => {
    const out = buildSubagentMessages(
      [assistant("u1", "msg_a", [{ type: "text", text: "hello" }], 1000)],
      PARENT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "assistant",
      parentToolUseId: PARENT,
      createdAt: 1000,
      blocks: [{ kind: "text", text: "hello" }],
    });
    expect(out[0].streaming).toBeFalsy();
  });

  test("coalesces assistant splits sharing one message.id into a single bubble", () => {
    const out = buildSubagentMessages(
      [
        assistant("u1", "msg_a", [{ type: "thinking", thinking: "hmm" }]),
        assistant("u2", "msg_a", [
          { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } },
        ]),
      ],
      PARENT,
    );
    expect(out).toHaveLength(1);
    expect(out[0].blocks).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } },
    ]);
  });

  test("renders a user message as a text bubble", () => {
    const out = buildSubagentMessages(
      [user("u1", [{ type: "text", text: "do the thing" }], 2000)],
      PARENT,
    );
    expect(out).toEqual([
      {
        uuid: "u1",
        role: "user",
        blocks: [{ kind: "text", text: "do the thing" }],
        parentToolUseId: PARENT,
        createdAt: 2000,
      },
    ]);
  });

  test("preserves arrival order across mixed roles", () => {
    const out = buildSubagentMessages(
      [
        user("u1", "spawn prompt"),
        assistant("u2", "msg_a", [{ type: "text", text: "working" }]),
      ],
      PARENT,
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("dedupes a user message replayed under the same uuid", () => {
    const dup = user("u1", "same");
    const out = buildSubagentMessages([dup, dup], PARENT);
    expect(out).toHaveLength(1);
  });

  test("drops empty-text user messages and ignores unknown roles", () => {
    const out = buildSubagentMessages(
      [user("u1", []), { at: 1, message: { type: "system", uuid: "s1" } }],
      PARENT,
    );
    expect(out).toEqual([]);
  });
});
