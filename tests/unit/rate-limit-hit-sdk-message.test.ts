import { describe, expect, test } from "vitest";
import { isRateLimitHitSdkMessage } from "@/lib/server/session";

/**
 * Server-side counterpart to `tests/unit/rate-limit-hit-detection.test.ts`
 * (the client's `isRateLimitHitText`). `isRateLimitHitSdkMessage` gates the
 * account-auto-rotate side effect in `noteAccountAutoRotateObservation`, so
 * false positives/negatives here have a real consequence (switching, or
 * failing to switch, the active credential) — not just a mis-rendered panel.
 */
function assistantMessage(text: string, opts?: { parentToolUseId?: string; extraBlocks?: unknown[] }) {
  return {
    type: "assistant",
    parent_tool_use_id: opts?.parentToolUseId,
    message: {
      content: [{ type: "text", text }, ...(opts?.extraBlocks ?? [])],
    },
  };
}

describe("isRateLimitHitSdkMessage", () => {
  test("matches the classic 'You've hit your … limit' template", () => {
    expect(isRateLimitHitSdkMessage(assistantMessage("You've hit your session limit · resets 8:10pm"))).toBe(true);
  });

  test("matches usage-limit templates the old narrow regex missed", () => {
    expect(isRateLimitHitSdkMessage(assistantMessage("You're out of usage credits"))).toBe(true);
    expect(
      isRateLimitHitSdkMessage(assistantMessage("Your org is out of usage · add funds to continue")),
    ).toBe(true);
    expect(isRateLimitHitSdkMessage(assistantMessage("Your seat type doesn't include usage credits"))).toBe(
      true,
    );
    expect(
      isRateLimitHitSdkMessage(assistantMessage("Your usage allocation has been disabled by your admin")),
    ).toBe(true);
    expect(isRateLimitHitSdkMessage(assistantMessage("Fable 5 requires usage credits"))).toBe(true);
    expect(isRateLimitHitSdkMessage(assistantMessage("You're out of extra usage"))).toBe(true);
  });

  test("ignores normal prose that merely mentions limits", () => {
    expect(isRateLimitHitSdkMessage(assistantMessage("Let me check whether we hit your rate limit."))).toBe(
      false,
    );
    expect(isRateLimitHitSdkMessage(assistantMessage("You've reached the end of the file."))).toBe(false);
  });

  test("ignores subagent (Task) messages — inner conversation, not the main wall", () => {
    expect(
      isRateLimitHitSdkMessage(assistantMessage("You've hit your session limit", { parentToolUseId: "t1" })),
    ).toBe(false);
  });

  test("ignores a mixed text+tool_use turn (a real turn, not a rate-limit wall)", () => {
    expect(
      isRateLimitHitSdkMessage(
        assistantMessage("You've hit your session limit", {
          extraBlocks: [{ type: "tool_use", id: "x", name: "Bash", input: {} }],
        }),
      ),
    ).toBe(false);
  });

  test("ignores non-assistant messages and malformed input", () => {
    expect(isRateLimitHitSdkMessage({ type: "user", message: { content: [] } })).toBe(false);
    expect(isRateLimitHitSdkMessage(null)).toBe(false);
    expect(isRateLimitHitSdkMessage("not a message")).toBe(false);
    expect(isRateLimitHitSdkMessage(assistantMessage(""))).toBe(false);
  });
});
