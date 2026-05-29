import { describe, expect, test } from "vitest";
import { upsertAssistantSplit } from "@/lib/client/use-session";
import type { DisplayBlock, DisplayMessage } from "@/lib/client/types";

/**
 * Regression coverage for the empty-thinking dedupe drop.
 *
 * Background: the Anthropic SDK emits adaptive thinking blocks that
 * sometimes have no visible body text — the model entered thinking mode
 * but didn't produce a textual trace for the turn. The terminal
 * `assistant` envelope still carries the block (with `thinking: ""`),
 * and the right-side activity rail surfaces a synthetic "Thinking" row
 * for every `content_block_start` of type thinking.
 *
 * The bug: `upsertAssistantSplit` used to early-skip thinking blocks
 * whose `text === ""` during its dedupe-and-append pass. That made
 * sense as a copy-paste from the `text` branch (empty user-visible
 * prose adds nothing), but for thinking it silently dropped the
 * envelope from the message's `blocks` array. End result: the user
 * saw "Thinking 5s" in the right rail with no corresponding pill in
 * the chat, even at verbose.
 *
 * The fix: dedupe by exact text match only. Empty-vs-empty still
 * collapses (no duplicate empty pills); empty-when-no-prior-thinking
 * is preserved (the envelope renders with "no readable trace" copy).
 */

function block(b: DisplayBlock): DisplayBlock {
  return b;
}

function existingMsg(blocks: DisplayBlock[]): DisplayMessage {
  return {
    uuid: "msg_001",
    role: "assistant",
    blocks,
    foldedSdkUuids: new Set(["sdk_prev"]),
    streaming: true,
  };
}

describe("upsertAssistantSplit · empty thinking preservation", () => {
  test("appends an empty thinking block when nothing in existing matches", () => {
    // The case from the user's screenshot: text + tool_use already in
    // the message (came from prior splits or scratch), and the next
    // terminal split carries an empty thinking envelope. Without the
    // fix this got silently dropped; with the fix it's appended.
    const prev = [existingMsg([
      block({ kind: "text", text: "I'll add it in three places:" }),
      block({ kind: "tool_use", id: "toolu_edit", name: "Edit", input: {} }),
    ])];
    const newBlocks: DisplayBlock[] = [block({ kind: "thinking", text: "" })];
    const out = upsertAssistantSplit(prev, "msg_001", "sdk_new", newBlocks, true);
    expect(out).toHaveLength(1);
    expect(out[0].blocks.map((b) => b.kind)).toEqual(["text", "tool_use", "thinking"]);
    expect(out[0].blocks[2]).toMatchObject({ kind: "thinking", text: "" });
  });

  test("dedupes a second empty thinking envelope against an existing one", () => {
    // The fix shouldn't ever produce two empty pills side by side —
    // empty matches empty under exact-text dedupe. This pins that.
    const prev = [existingMsg([block({ kind: "thinking", text: "" })])];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [block({ kind: "thinking", text: "" })],
      false,
    );
    // The thinking count stays at 1; the new split is folded but
    // contributes no new blocks.
    const thinkingCount = out[0].blocks.filter((b) => b.kind === "thinking").length;
    expect(thinkingCount).toBe(1);
  });

  test("dedupes thinking by exact text — same body collapses, different bodies coexist", () => {
    const prev = [
      existingMsg([block({ kind: "thinking", text: "weighing options" })]),
    ];
    // Same body → collapsed.
    const same = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_same",
      [block({ kind: "thinking", text: "weighing options" })],
      false,
    );
    expect(same[0].blocks.filter((b) => b.kind === "thinking")).toHaveLength(1);

    // Different body → both kept (legitimate multi-thinking turn).
    const different = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_diff",
      [block({ kind: "thinking", text: "now I'll plan the edit" })],
      false,
    );
    expect(different[0].blocks.filter((b) => b.kind === "thinking")).toHaveLength(2);
  });

  test("creates a new bubble with the empty thinking envelope when no prior split exists", () => {
    // idx === -1 path: no existing bubble for this messageId. When
    // `hasStreamScratch=false` the bubble is seeded with `newBlocks`
    // directly — empty thinking must survive that path too.
    const out = upsertAssistantSplit(
      [],
      "msg_new",
      "sdk_only",
      [block({ kind: "thinking", text: "" }), block({ kind: "text", text: "ok" })],
      false,
    );
    expect(out).toHaveLength(1);
    expect(out[0].blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
  });

  test("still skips empty TEXT blocks — that branch's reason is unchanged", () => {
    // The dedupe fix only loosened thinking. The `text === ""` early
    // skip on the `text` branch stays because an empty text block
    // genuinely adds no signal (no envelope, no body).
    const prev = [existingMsg([block({ kind: "text", text: "hello" })])];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [block({ kind: "text", text: "" })],
      false,
    );
    expect(out[0].blocks).toHaveLength(1);
  });

  test("dedupes tool_use by id (unchanged behaviour)", () => {
    // Sanity: the fix didn't touch tool_use dedupe — same id collapses
    // even when input objects differ (the result is folded onto the
    // existing block elsewhere via the user/tool_result handler).
    const prev = [
      existingMsg([block({ kind: "tool_use", id: "toolu_x", name: "Bash", input: {} })]),
    ];
    const out = upsertAssistantSplit(
      prev,
      "msg_001",
      "sdk_new",
      [block({ kind: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } })],
      false,
    );
    expect(out[0].blocks.filter((b) => b.kind === "tool_use")).toHaveLength(1);
  });
});
