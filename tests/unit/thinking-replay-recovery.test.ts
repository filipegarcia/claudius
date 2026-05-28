import { describe, expect, test } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  isThinkingReplayErrorText,
  planThinkingReplayRecovery,
  thinkingReplayErrorFrom,
} from "@/lib/server/thinking-replay-recovery";

const REAL_ERROR =
  "API Error: 400 messages.25.content.23: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

function msg(
  type: SessionMessage["type"],
  uuid: string,
  content: unknown,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "s",
    message: { role: type, content },
    parent_tool_use_id: null,
  } as SessionMessage;
}

describe("isThinkingReplayErrorText", () => {
  test("matches the real thinking-block 400 (any content index)", () => {
    expect(isThinkingReplayErrorText(REAL_ERROR)).toBe(true);
    expect(
      isThinkingReplayErrorText(
        "messages.4.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
      ),
    ).toBe(true);
  });

  test("does NOT match the transient socket error or unrelated 400s", () => {
    expect(
      isThinkingReplayErrorText(
        "API Error: The socket connection was closed unexpectedly.",
      ),
    ).toBe(false);
    expect(
      isThinkingReplayErrorText("API Error: 400 messages: roles must alternate"),
    ).toBe(false);
    // A thinking-related message that is not the immutability rejection.
    expect(
      isThinkingReplayErrorText("thinking budget exceeded the maximum"),
    ).toBe(false);
  });
});

describe("thinkingReplayErrorFrom", () => {
  test("extracts the error text from a synthetic assistant message", () => {
    const m = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: REAL_ERROR }] },
    };
    expect(thinkingReplayErrorFrom(m)).toBe(REAL_ERROR);
  });

  test("ignores non-assistant records and unrelated assistant text", () => {
    expect(
      thinkingReplayErrorFrom({
        type: "user",
        message: { role: "user", content: REAL_ERROR },
      }),
    ).toBeNull();
    expect(
      thinkingReplayErrorFrom({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
      }),
    ).toBeNull();
    expect(thinkingReplayErrorFrom(null)).toBeNull();
  });
});

describe("planThinkingReplayRecovery", () => {
  test("rewinds to the assistant boundary before the last real prompt", () => {
    const messages: SessionMessage[] = [
      msg("user", "u0", "first prompt"),
      msg("assistant", "a0", [{ type: "text", text: "ok" }]),
      // The prompt that kicked off the poisoned turn.
      msg("user", "u1", "all 14, in batches"),
      // Poisoned turn (interleaved thinking + tool_use), then its tool traffic.
      msg("assistant", "a1", [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ]),
      msg("user", "tr1", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
    ];

    const plan = planThinkingReplayRecovery(messages);
    expect(plan).toEqual({
      resumeAt: "a0",
      replayPrompt: "all 14, in batches",
      replayPromptUuid: "u1",
    });
  });

  test("skips tool_result-only user records when finding the prompt", () => {
    const messages: SessionMessage[] = [
      msg("assistant", "a0", [{ type: "text", text: "ok" }]),
      msg("user", "u1", "real prompt"),
      msg("assistant", "a1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      // Trailing tool_result user record must not be mistaken for the prompt.
      msg("user", "tr1", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
    ];
    const plan = planThinkingReplayRecovery(messages);
    expect(plan?.resumeAt).toBe("a0");
    expect(plan?.replayPrompt).toBe("real prompt");
  });

  test("rewinds past the poisoned turn even after a fresh prompt was sent (already-wedged session)", () => {
    // The session wedged on a1, then the user sent another prompt (u2) which
    // also 400s because a1 is still replayed. Recovery must rewind past a1 —
    // anchoring on the *last* prompt (u2) would resume at the poison.
    const messages: SessionMessage[] = [
      msg("assistant", "a0", [{ type: "text", text: "ok" }]),
      msg("user", "u1", "all 14, in batches"),
      msg("assistant", "a1", [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ]),
      msg("user", "tr1", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
      // Fresh prompt the user typed after it wedged.
      msg("user", "u2", "are you stuck?"),
    ];
    const plan = planThinkingReplayRecovery(messages);
    expect(plan?.resumeAt).toBe("a0");
    expect(plan?.replayPrompt).toBe("all 14, in batches");
    expect(plan?.replayPromptUuid).toBe("u1");
  });

  test("returns null when the poisoned turn was the very first turn", () => {
    // No assistant boundary precedes the only real prompt → nothing safe to
    // resume at.
    const messages: SessionMessage[] = [
      msg("user", "u1", "first and only prompt"),
      msg("assistant", "a1", [{ type: "thinking", thinking: "", signature: "s" }]),
    ];
    expect(planThinkingReplayRecovery(messages)).toBeNull();
  });

  test("returns null when there is no real user prompt", () => {
    const messages: SessionMessage[] = [
      msg("assistant", "a0", [{ type: "text", text: "hi" }]),
      msg("user", "tr1", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
    ];
    expect(planThinkingReplayRecovery(messages)).toBeNull();
  });
});
