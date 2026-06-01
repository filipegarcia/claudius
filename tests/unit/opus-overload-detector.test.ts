import { describe, expect, test } from "vitest";
import {
  isOpusModelId,
  isOverloadErrorText,
  isOverloadSignal,
} from "@/lib/server/opus-overload-detector";

describe("isOverloadErrorText", () => {
  test("matches the standard 529 overload phrasings", () => {
    expect(isOverloadErrorText("API Error: 529 Overloaded")).toBe(true);
    expect(isOverloadErrorText("overloaded — please retry later")).toBe(true);
    expect(
      isOverloadErrorText("API Error 529 {\"type\":\"overloaded_error\"}"),
    ).toBe(true);
  });

  test("rejects unrelated errors that happen to contain '529' as a fragment", () => {
    // A uuid fragment that just happens to contain "529" should not trip;
    // the matcher requires either the word "overloaded" or "529" alongside an
    // http-style "api error"/"status" anchor.
    expect(isOverloadErrorText("uuid 11529abc-ffff something happened")).toBe(false);
    expect(isOverloadErrorText("API Error: 400 — bad request")).toBe(false);
    expect(isOverloadErrorText("")).toBe(false);
  });
});

describe("isOverloadSignal", () => {
  test("trips on a synthetic assistant API-error message containing 529", () => {
    const msg = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "API Error: 529 Overloaded" }],
      },
    };
    expect(isOverloadSignal(msg)).toBe(true);
  });

  test("trips on an error_during_execution result with overload in errors[]", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["upstream Overloaded — retries exhausted"],
    };
    expect(isOverloadSignal(msg)).toBe(true);
  });

  test("does NOT trip on the fallback-rescued success path", () => {
    // SDK's SDKResultSuccess carries api_error_status; the turn succeeded so
    // the user does not need a nudge. We deliberately only count the failed
    // surfaces (assistant API-error message + error_during_execution result).
    const msg = {
      type: "result",
      subtype: "success",
      api_error_status: 529,
    };
    expect(isOverloadSignal(msg)).toBe(false);
  });

  test("does NOT trip on regular assistant text or tool_use messages", () => {
    expect(
      isOverloadSignal({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "All good." }] },
      }),
    ).toBe(false);
    expect(isOverloadSignal({ type: "system", subtype: "init" })).toBe(false);
    expect(isOverloadSignal(null)).toBe(false);
  });
});

describe("isOpusModelId", () => {
  test("matches Opus model ids and rejects Sonnet/Haiku", () => {
    expect(isOpusModelId("claude-opus-4-7")).toBe(true);
    expect(isOpusModelId("anthropic.claude-opus-4-20250514-v1:0")).toBe(true);
    expect(isOpusModelId("claude-sonnet-4-6")).toBe(false);
    expect(isOpusModelId("claude-haiku-4")).toBe(false);
    expect(isOpusModelId(null)).toBe(false);
    expect(isOpusModelId(undefined)).toBe(false);
    expect(isOpusModelId("")).toBe(false);
  });
});
