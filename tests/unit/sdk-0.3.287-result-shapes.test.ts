import { describe, expect, test } from "vitest";
import { extractToolResult } from "@/lib/client/use-session";
import {
  isAuthFailedErrorText,
  isOAuthRevokedSignal,
  isOAuthRevokedText,
} from "@/lib/server/auth-failed-detector";

/** SDK 0.3.287 / Claude Code 2.1.287 wire-shape changes Claudius now reads. */

describe("extractToolResult — detachedToolCall", () => {
  const content = [{ type: "tool_result", tool_use_id: "tu1", content: "Moved to the background" }];

  test("a WebFetch/WebSearch that stepped aside for a priority 'now' message is flagged detached", () => {
    expect(extractToolResult(content, { detachedToolCall: true })).toEqual({
      tool_use_id: "tu1",
      text: "Moved to the background",
      isError: undefined,
      detached: true,
    });
  });

  test("ordinary results carry no detached flag", () => {
    const r = extractToolResult(content, { url: "https://x", code: 200 });
    expect(r && "detached" in r).toBe(false);
    expect(extractToolResult(content, undefined)).not.toHaveProperty("detached");
  });

  test("staged still reads independently", () => {
    expect(extractToolResult(content, { staged: true })).toMatchObject({ staged: true });
  });
});

describe("OAuth token revoked", () => {
  const TEXT = "Failed to authenticate: OAuth token revoked";

  test("is still an auth failure, and is recognised as a revocation", () => {
    expect(isAuthFailedErrorText(TEXT)).toBe(true);
    expect(isOAuthRevokedText(TEXT)).toBe(true);
    expect(isOAuthRevokedText("API Error: 401 authentication_error")).toBe(false);
  });

  test("reads the synthetic assistant body", () => {
    expect(
      isOAuthRevokedSignal({ type: "assistant", message: { content: [{ type: "text", text: TEXT }] } }),
    ).toBe(true);
    expect(isOAuthRevokedSignal({ type: "user", message: { content: TEXT } })).toBe(false);
  });
});
