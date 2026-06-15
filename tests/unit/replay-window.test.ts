import { describe, expect, test } from "vitest";
import { computeReplayWindow } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Regression coverage for the SSE replay-window slicing in
 * `lib/server/session.ts`. The slicing decides which buffered events a
 * newly-attached client receives on `subscribe()`.
 *
 * Bug we're guarding against (2026-05-11): in a Claude Code session
 * with heavy tool use, a single user prompt is followed by many
 * assistant turns (one per tool round-trip). The naive "last N top-
 * level turns" tail then drops the user message off the top, and the
 * client lands with no visible context for what was asked. The fix
 * extends the window upward to always include the most recent user
 * turn — these tests pin that behavior down.
 *
 * The slicing is a pure function over the event buffer, so we hand-build
 * fixtures rather than spin up a real Session.
 */

function sdkUser(uuid: string, at?: number): ServerEvent {
  return {
    type: "sdk",
    ...(typeof at === "number" ? { at } : {}),
    message: {
      type: "user",
      uuid,
      message: { content: [{ type: "text", text: `prompt ${uuid}` }] },
    },
  } as unknown as ServerEvent;
}

/**
 * SDK-synthetic user-role message that wraps a tool_result. Claude Code
 * emits one of these for every tool round-trip; dozens of them sit
 * between real user prompts and they must NOT be treated as user turns
 * by the replay-window anchor.
 */
function sdkToolResultWrapper(uuid: string, toolUseId = "tool-x"): ServerEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      message: {
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
        ],
      },
    },
  } as unknown as ServerEvent;
}

function sdkAssistant(uuid: string, opts?: { subagent?: boolean; at?: number }): ServerEvent {
  return {
    type: "sdk",
    ...(typeof opts?.at === "number" ? { at: opts.at } : {}),
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: opts?.subagent ? "tool-x" : null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: `reply ${uuid}` }],
      },
    },
  } as unknown as ServerEvent;
}

function sdkSystem(uuid: string): ServerEvent {
  return {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid },
  } as unknown as ServerEvent;
}

/**
 * Image-only user prompt — a screenshot paste with no accompanying text.
 * `isRealUserPrompt`/`extractUserPromptText` return null for these (they
 * carry no prose), but they're genuine user input and MUST be able to anchor
 * the replay window. Real sessions split a pasted image into an image-only
 * record plus a separate `[Image: …]` caption record; this models the
 * image-only half.
 */
function sdkImagePrompt(uuid: string, at?: number): ServerEvent {
  return {
    type: "sdk",
    ...(typeof at === "number" ? { at } : {}),
    message: {
      type: "user",
      uuid,
      message: {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
    },
  } as unknown as ServerEvent;
}

describe("computeReplayWindow", () => {
  test("returns the whole buffer when tail is unset", () => {
    const buffer = [sdkUser("u1"), sdkAssistant("a1")];
    expect(computeReplayWindow(buffer, undefined)).toEqual({
      startIdx: 0,
      hasMoreAbove: false,
    });
  });

  test("returns the whole buffer when tail is 0 or negative", () => {
    const buffer = [sdkUser("u1"), sdkAssistant("a1")];
    expect(computeReplayWindow(buffer, 0)).toEqual({ startIdx: 0, hasMoreAbove: false });
    expect(computeReplayWindow(buffer, -3)).toEqual({ startIdx: 0, hasMoreAbove: false });
  });

  test("keeps the whole buffer when turn count is within tail budget", () => {
    // 3 top-level turns, tail=20 → nothing to drop.
    const buffer = [sdkUser("u1"), sdkAssistant("a1"), sdkUser("u2")];
    expect(computeReplayWindow(buffer, 20)).toEqual({
      startIdx: 0,
      hasMoreAbove: false,
    });
  });

  test("slices to the last N turns when buffer exceeds tail budget (the easy case)", () => {
    // 5 top-level turns, tail=2 → keep the last 2 turns. The slice starts at
    // the index of the 4th turn (0-indexed: turn at position 3).
    const buffer: ServerEvent[] = [
      sdkUser("u1"), // turn 0, idx 0
      sdkAssistant("a1"), // turn 1, idx 1
      sdkUser("u2"), // turn 2, idx 2
      sdkAssistant("a2"), // turn 3, idx 3
      sdkUser("u3"), // turn 4, idx 4
    ];
    const out = computeReplayWindow(buffer, 2);
    // skip = 5 - 2 = 3 → start at turnIdx[3] = idx 3 (a2).
    // Last user turn (u3, idx 4) is INSIDE that window, so no extension.
    expect(out).toEqual({ startIdx: 3, hasMoreAbove: true });
  });

  test("extends the window upward to include the most recent user turn (the bug)", () => {
    // Simulates the failure mode: one user prompt followed by a long
    // assistant/tool chain. tail=3 would normally keep just the last 3
    // assistant turns and drop the user prompt — we want to extend it back.
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"), // turn 0, idx 0 (e.g. session resume prelude)
      sdkUser("u1"), // turn 1, idx 1  ← MUST be included
      sdkAssistant("a1"), // turn 2, idx 2
      sdkAssistant("a2"), // turn 3, idx 3
      sdkAssistant("a3"), // turn 4, idx 4
      sdkAssistant("a4"), // turn 5, idx 5
      sdkAssistant("a5"), // turn 6, idx 6
    ];
    const out = computeReplayWindow(buffer, 3);
    // Naive slice would start at turnIdx[4] = idx 4 — the user message
    // would be dropped. With the fix, start extends back to idx 1.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("non-sdk and subagent events don't count as top-level turns", () => {
    // System messages, ready events, and subagent (parent_tool_use_id != null)
    // messages must not affect the turn count or the user-anchor.
    const buffer: ServerEvent[] = [
      sdkSystem("sys"), // idx 0 — not a turn
      sdkUser("u1"), // idx 1 — turn
      sdkAssistant("sub1", { subagent: true }), // idx 2 — subagent, not a turn
      sdkAssistant("a1"), // idx 3 — turn
      sdkAssistant("a2"), // idx 4 — turn
      sdkAssistant("a3"), // idx 5 — turn
    ];
    const out = computeReplayWindow(buffer, 2);
    // 4 top-level turns (u1, a1, a2, a3); tail=2 → naive start at turnIdx[2] = idx 4 (a2).
    // u1 (idx 1) is BEFORE that window — anchor extends back to idx 1.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("does not extend when the most recent user turn is already in window", () => {
    // The user message is in the trailing chunk; no extension needed.
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"),
      sdkAssistant("a1"),
      sdkAssistant("a2"),
      sdkUser("u1"), // most recent user turn, idx 3
      sdkAssistant("a3"),
    ];
    const out = computeReplayWindow(buffer, 2);
    // 5 turns, tail=2 → start at turnIdx[3] = idx 3 (u1). u1 is the boundary,
    // no extension required.
    expect(out).toEqual({ startIdx: 3, hasMoreAbove: true });
  });

  test("hasMoreAbove flips to false when the user-anchor extension reaches idx 0", () => {
    // The user message IS the first event in the buffer; extending to
    // include it means we're emitting from the very start, so there's
    // nothing older to load.
    const buffer: ServerEvent[] = [
      sdkUser("u1"), // idx 0
      sdkAssistant("a1"),
      sdkAssistant("a2"),
      sdkAssistant("a3"),
      sdkAssistant("a4"),
    ];
    const out = computeReplayWindow(buffer, 2);
    // Naive: turnIdx = [0, 1, 2, 3, 4]; skip=3; naive start at idx 3.
    // u1 at idx 0 is older — extend back. startIdx=0 → hasMoreAbove=false.
    expect(out).toEqual({ startIdx: 0, hasMoreAbove: false });
  });

  test("tool_result wrappers don't count as user-turn anchors (real-world bug)", () => {
    // Reproduction of the acf58f85-… session shape: one real user prompt
    // followed by many assistant/tool_result_wrapper pairs. Without the
    // synthetic-vs-real distinction, the anchor would land on the most
    // recent tool_result wrapper (already in the default tail) and the
    // actual user prompt would still get dropped off the top.
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"), // turn 0, idx 0
      sdkUser("u1"), // turn 1, idx 1  ← REAL prompt, must end up included
      sdkAssistant("a1"), // turn 2, idx 2 — tool_use here in real life
      sdkToolResultWrapper("tr1"), // turn 3, idx 3 — synthetic
      sdkAssistant("a2"), // turn 4, idx 4
      sdkToolResultWrapper("tr2"), // turn 5, idx 5 — synthetic
      sdkAssistant("a3"), // turn 6, idx 6
      sdkToolResultWrapper("tr3"), // turn 7, idx 7 — synthetic (most recent)
      sdkAssistant("a4"), // turn 8, idx 8
    ];
    const out = computeReplayWindow(buffer, 3);
    // tool_result wrappers count as neither turns nor anchors, so the real
    // turns are [a0, u1, a1, a2, a3, a4] at idxs [0,1,2,4,6,8] (6 turns).
    // tail=3 → naive start at turnIdx[3] = idx 4 (a2). The only real prompt
    // (u1, idx 1) is older than the naive start → extend back to idx 1.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("task-notification wrappers don't count as user-turn anchors", () => {
    // Similar shape to the tool_result-wrapper bug: the SDK injects a
    // <task-notification> user-role message every time a background bash
    // task finishes. It carries plain text content (no tool_result block),
    // so the naive "text-or-image" check considers it a real prompt — but
    // the user didn't type it, and anchoring on it cuts off the actual
    // previous prompt.
    const taskNotif: ServerEvent = {
      type: "sdk",
      message: {
        type: "user",
        uuid: "tn1",
        message: {
          content: [
            {
              type: "text",
              text: "<task-notification>\n<task-id>b3bllp7t9</task-id>\n<status>killed</status>\n</task-notification>",
            },
          ],
        },
      },
    } as unknown as ServerEvent;
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"), // turn 0, idx 0
      sdkUser("u1"), // turn 1, idx 1  ← REAL prompt
      sdkAssistant("a1"), // turn 2, idx 2
      sdkAssistant("a2"), // turn 3, idx 3
      taskNotif, // turn 4, idx 4  ← synthetic, must NOT anchor
      sdkAssistant("a3"), // turn 5, idx 5
      sdkAssistant("a4"), // turn 6, idx 6
    ];
    const out = computeReplayWindow(buffer, 2);
    // taskNotif counts as neither a turn nor an anchor, so the real turns are
    // [a0, u1, a1, a2, a3, a4] at idxs [0,1,2,3,5,6] (6 turns). tail=2 → naive
    // start at turnIdx[4] = idx 5 (a3). The real prompt (u1, idx 1) is older →
    // extend back to idx 1, skipping the synthetic notification entirely.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("string-content user prompts are treated as real (regression: SDK uses both shapes)", () => {
    // The SDK emits user messages with `content: "string"` for simple
    // prompts and `content: [{type:"text", ...}]` for prompts with
    // attachments. Both must anchor.
    const stringPrompt = {
      type: "sdk",
      message: {
        type: "user",
        uuid: "u-str",
        message: { content: "literal string prompt" },
      },
    } as unknown as ServerEvent;
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"),
      stringPrompt, // idx 1 — real, string content
      sdkAssistant("a1"),
      sdkAssistant("a2"),
      sdkAssistant("a3"),
      sdkAssistant("a4"),
    ];
    const out = computeReplayWindow(buffer, 2);
    // 6 turns, tail=2 → naive start at turnIdx[4] = idx 4. String-content
    // user message at idx 1 must extend the window back to it.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("anchors on the chronologically latest user when the buffer arrival order drifts", () => {
    // A disk resync can append older JSONL records after newer live events.
    // The replay anchor must use event.at chronology, not whichever user
    // happened to be appended last, otherwise refresh can replay an old turn
    // as the visible/latest prompt and omit the actual current question.
    const buffer: ServerEvent[] = [
      sdkUser("u-new", 3_000), // idx 0 — chronological latest user
      sdkAssistant("a-new-1", { at: 3_001 }),
      sdkAssistant("a-new-2", { at: 3_002 }),
      sdkUser("u-old", 1_000), // idx 3 — older, but appended later
      sdkAssistant("a-old-1", { at: 1_001 }),
      sdkAssistant("a-old-2", { at: 1_002 }),
    ];
    const out = computeReplayWindow(buffer, 2);

    // Naive buffer-order anchoring would extend only to idx 3 (u-old).
    // Correct chronological anchoring extends to idx 0 (u-new).
    expect(out).toEqual({ startIdx: 0, hasMoreAbove: false });
  });

  test("tool-heavy short conversation opens on the first prompt, not mid-chain (2026-06 bug)", () => {
    // The reported regression: a conversation that is SHORT in human terms
    // (one prompt, a handful of replies) but tool-heavy generates many
    // tool_result bookkeeping records. When those counted toward the tail
    // budget, a session the user thinks of as "small" still blew past tail
    // and the window opened on an assistant/tool turn ("started on an agent")
    // with the prompt sliced off the top.
    const buffer: ServerEvent[] = [
      sdkUser("u1"), // idx 0 — the only real prompt
      sdkAssistant("a1"), // idx 1
      sdkToolResultWrapper("tr1"), // idx 2 — bookkeeping, not a turn
      sdkAssistant("a2"), // idx 3
      sdkToolResultWrapper("tr2"), // idx 4 — bookkeeping
      sdkUser("u2"), // idx 5 — a follow-up prompt
      sdkAssistant("a3"), // idx 6
      sdkToolResultWrapper("tr3"), // idx 7 — bookkeeping
    ];
    const out = computeReplayWindow(buffer, 5);
    // Real turns are [u1, a1, a2, u2, a3] (5) — within the tail=5 budget — so
    // the whole buffer replays from the top and the first prompt is visible.
    // OLD behavior counted the 3 tool_result wrappers too (8 "turns" > 5),
    // sliced to a naive start at idx 3 (a2), and — because the latest prompt
    // u2 was inside that window — never extended back, opening on an agent.
    expect(out).toEqual({ startIdx: 0, hasMoreAbove: false });
  });

  test("image-only prompts anchor the window (regression: image pastes carry no text)", () => {
    // An image-only paste is real user input but has no prose, so the
    // text-based `isRealUserPrompt` rejected it. That left the replay anchor
    // unable to land on it: a reattach right after pasting a screenshot would
    // fall through to the assistant/tool turn that followed.
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"), // idx 0
      sdkImagePrompt("img1"), // idx 1 — image-only prompt, MUST anchor
      sdkAssistant("a1"), // idx 2
      sdkAssistant("a2"), // idx 3
      sdkAssistant("a3"), // idx 4
    ];
    const out = computeReplayWindow(buffer, 2);
    // Real turns [a0, img1, a1, a2, a3]; tail=2 → naive start at turnIdx[3] =
    // idx 3 (a2). img1 (idx 1) is the latest anchorable prompt and is older
    // than the naive start → extend back to idx 1. OLD behavior found no
    // anchorable user (image rejected) and opened on a2 at idx 3.
    expect(out).toEqual({ startIdx: 1, hasMoreAbove: true });
  });

  test("image-only prompt counts toward the tail budget like any real turn", () => {
    // Companion to the anchor test: an image-only prompt is a conversational
    // turn, so it occupies a budget slot (it isn't skipped like a tool_result
    // wrapper). Here the whole short exchange fits within tail and replays
    // from the top.
    const buffer: ServerEvent[] = [
      sdkImagePrompt("img1"), // idx 0
      sdkAssistant("a1"), // idx 1
      sdkToolResultWrapper("tr1"), // idx 2 — not a turn
      sdkAssistant("a2"), // idx 3
    ];
    const out = computeReplayWindow(buffer, 3);
    // Real turns [img1, a1, a2] (3) == tail budget → nothing dropped.
    expect(out).toEqual({ startIdx: 0, hasMoreAbove: false });
  });

  test("no user turn anywhere in buffer → behaves like the naive tail", () => {
    // Edge case: a session that only ever broadcast assistant events
    // (e.g. resumed prelude before any user input). The extension has
    // nothing to anchor on; tail behaves the original way.
    const buffer: ServerEvent[] = [
      sdkAssistant("a0"),
      sdkAssistant("a1"),
      sdkAssistant("a2"),
      sdkAssistant("a3"),
    ];
    const out = computeReplayWindow(buffer, 2);
    // 4 turns, tail=2 → start at turnIdx[2] = idx 2. No user, no extension.
    expect(out).toEqual({ startIdx: 2, hasMoreAbove: true });
  });
});
