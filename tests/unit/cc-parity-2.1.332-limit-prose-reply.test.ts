import { describe, expect, test } from "vitest";
import { isSyntheticApiMessage } from "@/lib/shared/rate-limit-prefixes";
import { isRateLimitHitMessage, synthesizeOlder } from "@/lib/client/use-session";
import { isRateLimitHitSdkMessage } from "@/lib/server/session";
import type { DisplayBlock } from "@/lib/client/types";

/**
 * CC 2.1.332 — "Fixed replies that start with phrases like "You've used" or
 * "You've hit your" showing as a red usage limit error".
 *
 * Claudius matched the limit prose on any text-only assistant message, so an
 * ordinary reply opening "You've hit your…" became the red rate-limit panel
 * (and, server-side, rotated the next session to another account). Only the
 * engine's synthetic API-error message counts now: `error` set (live), or
 * `message.model: "<synthetic>"` (live, replay and pagination alike).
 */

const PROSE = "You've hit your limit on retries, so I stopped and left the branch as is.";
const LIMIT = "You've hit your 5-hour limit · resets 12:40am (Europe/Berlin)";

const blocks = (t: string): DisplayBlock[] => [{ kind: "text", text: t }];

function reply(text: string, model: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: `u-${model}`,
    parent_tool_use_id: null,
    ...extra,
    message: { id: `msg-${model}`, model, role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("isSyntheticApiMessage", () => {
  test("a set `error` or the `<synthetic>` model marks the engine's API-error message", () => {
    expect(isSyntheticApiMessage({ error: "rate_limit" })).toBe(true);
    expect(isSyntheticApiMessage({ message: { model: "<synthetic>" } })).toBe(true);
  });
  test("a real model reply is not one", () => {
    expect(isSyntheticApiMessage({ message: { model: "claude-opus-5-5" } })).toBe(false);
    expect(isSyntheticApiMessage({ error: "" })).toBe(false);
    expect(isSyntheticApiMessage(null)).toBe(false);
    expect(isSyntheticApiMessage("x")).toBe(false);
  });
});

describe("isRateLimitHitMessage (live and SSE replay)", () => {
  test("an ordinary reply that opens with a limit prefix is not a limit hit", () => {
    expect(isRateLimitHitMessage(reply(PROSE, "claude-opus-5-5"), blocks(PROSE))).toBe(false);
  });
  test("the same text on a synthetic message is (replay: `error` is gone, the model survives)", () => {
    expect(isRateLimitHitMessage(reply(LIMIT, "<synthetic>"), blocks(LIMIT))).toBe(true);
  });
  test("`error: rate_limit` live is still the fast path", () => {
    expect(isRateLimitHitMessage({ error: "rate_limit", message: {} }, blocks("anything"))).toBe(true);
  });
});

describe("synthesizeOlder (pagination)", () => {
  test("tags only the synthetic limit message", () => {
    const { messages } = synthesizeOlder([
      reply(PROSE, "claude-opus-5-5"),
      reply(LIMIT, "<synthetic>"),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].rateLimitHit).toBeUndefined();
    expect(messages[1].rateLimitHit).toBeDefined();
  });
});

describe("isRateLimitHitSdkMessage (account auto-rotate)", () => {
  test("does not rotate on an ordinary reply", () => {
    expect(isRateLimitHitSdkMessage(reply(PROSE, "claude-opus-5-5"))).toBe(false);
  });
  test("rotates on the engine's limit stop", () => {
    expect(isRateLimitHitSdkMessage(reply(LIMIT, "<synthetic>", { error: "rate_limit" }))).toBe(true);
    expect(isRateLimitHitSdkMessage(reply(LIMIT, "<synthetic>"))).toBe(true);
  });
});
