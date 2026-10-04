import { describe, expect, test } from "vitest";
import { upsertAssistantSplit } from "@/lib/client/use-session";
import type { DisplayBlock, DisplayMessage } from "@/lib/client/types";

/**
 * CC 2.1.243 (C3) — a generic SDKAssistantMessageError frame (server_error,
 * billing_error, invalid_request, …) is threaded through upsertAssistantSplit
 * as a sticky `errorTag` (same pattern as `aborted`/`opusHighDemand`) so the
 * bubble renders error styling instead of ordinary model prose.
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

// positional args after `hasStreamScratch`: parentToolUseId, at, rateLimitHit,
// opusHighDemand, aborted, errorTag
describe("upsertAssistantSplit · errorTag (CC 2.1.243)", () => {
  test("new bubble carries the errorTag when the split is an error frame", () => {
    const out = upsertAssistantSplit(
      [],
      "msg_new",
      "sdk_only",
      [{ kind: "text", text: "The server had an error." }],
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "server_error",
    );
    expect(out[0].errorTag).toBe("server_error");
  });

  test("new bubble omits errorTag for an ordinary reply", () => {
    const out = upsertAssistantSplit([], "msg_new", "sdk_only", [{ kind: "text", text: "hi" }], false);
    expect(out[0].errorTag).toBeUndefined();
  });

  test("sticky: an error bubble keeps its tag after a later untagged split", () => {
    const prev = [existingMsg([{ kind: "text", text: "partial" }], { errorTag: "billing_error" })];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [{ kind: "tool_use", id: "toolu_x", name: "Bash", input: {} }],
      false,
    );
    expect(out[0].errorTag).toBe("billing_error");
  });
});
