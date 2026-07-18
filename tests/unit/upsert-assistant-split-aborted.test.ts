import { describe, expect, test } from "vitest";
import { upsertAssistantSplit } from "@/lib/client/use-session";
import type { DisplayBlock, DisplayMessage } from "@/lib/client/types";

/**
 * Coverage for the SDK 0.3.214 `aborted` flag: `SDKAssistantMessage.aborted`
 * is true when a message was truncated by an interrupt before the stream
 * completed. `upsertAssistantSplit` threads it through as a sticky flag
 * (same pattern as `opusHighDemand`) so a later untagged split can't clear
 * a bubble that was already marked aborted.
 */

function existingMsg(blocks: DisplayBlock[], extra: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    uuid: "msg_001",
    role: "assistant",
    blocks,
    foldedSdkUuids: new Set(["sdk_prev"]),
    streaming: true,
    ...extra,
  };
}

describe("upsertAssistantSplit · aborted (SDK 0.3.214)", () => {
  test("new bubble carries aborted: true when the split is tagged aborted", () => {
    const out = upsertAssistantSplit(
      [],
      "msg_new",
      "sdk_only",
      [{ kind: "text", text: "cut off mid-wo" }],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(out).toHaveLength(1);
    expect(out[0].aborted).toBe(true);
  });

  test("new bubble omits aborted when the split isn't tagged", () => {
    const out = upsertAssistantSplit(
      [],
      "msg_new",
      "sdk_only",
      [{ kind: "text", text: "complete answer" }],
      false,
    );
    expect(out[0].aborted).toBeUndefined();
  });

  test("sticky: an aborted bubble stays aborted after a later untagged split", () => {
    const prev = [existingMsg([{ kind: "text", text: "partial" }], { aborted: true })];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [{ kind: "tool_use", id: "toolu_x", name: "Bash", input: {} }],
      false,
      // parentToolUseId, at, rateLimitHit, opusHighDemand, aborted all omitted/undefined
    );
    expect(out[0].aborted).toBe(true);
  });

  test("a split arriving later CAN mark a previously-untagged bubble aborted", () => {
    const prev = [existingMsg([{ kind: "text", text: "streaming so far" }])];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [{ kind: "tool_use", id: "toolu_y", name: "Read", input: {} }],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(out[0].aborted).toBe(true);
  });

  test("subagent split path (parentToolUseId set) also threads aborted through", () => {
    const out = upsertAssistantSplit(
      [],
      "msg_sub",
      "sdk_sub",
      [{ kind: "text", text: "subagent cut short" }],
      false,
      "toolu_parent",
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(out[0].aborted).toBe(true);
    expect(out[0].parentToolUseId).toBe("toolu_parent");
  });
});
