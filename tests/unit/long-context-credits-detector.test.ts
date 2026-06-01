import { describe, expect, test } from "vitest";
import { isBillingErrorSignal } from "@/lib/server/long-context-credits-detector";

describe("isBillingErrorSignal", () => {
  test("trips on an assistant message tagged with the SDK's billing_error enum", () => {
    // Shape mirrors `SDKAssistantMessage` in @anthropic-ai/claude-agent-sdk
    // (`sdk.d.ts`): the structured `error` field carries one of
    // `SDKAssistantMessageError` — `'billing_error'` is the channel for
    // credit-required failures (out-of-credits, no extra-usage allowance, etc).
    const msg = {
      type: "assistant",
      error: "billing_error",
      message: { role: "assistant", content: [] },
    };
    expect(isBillingErrorSignal(msg)).toBe(true);
  });

  test("ignores other SDKAssistantMessageError enum values", () => {
    // Authentication/rate-limit/model-not-found/etc each get their own
    // surfaces in the chat — this detector is scoped to the billing path.
    for (const error of [
      "authentication_failed",
      "rate_limit",
      "invalid_request",
      "model_not_found",
      "server_error",
      "max_output_tokens",
      "unknown",
    ]) {
      expect(isBillingErrorSignal({ type: "assistant", error })).toBe(false);
    }
  });

  test("ignores assistant messages with no error field", () => {
    expect(
      isBillingErrorSignal({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ).toBe(false);
  });

  test("ignores non-assistant messages even if they happen to carry an error field", () => {
    expect(isBillingErrorSignal({ type: "result", error: "billing_error" })).toBe(
      false,
    );
    expect(isBillingErrorSignal({ type: "system", error: "billing_error" })).toBe(
      false,
    );
  });

  test("rejects null / non-object input", () => {
    expect(isBillingErrorSignal(null)).toBe(false);
    expect(isBillingErrorSignal(undefined)).toBe(false);
    expect(isBillingErrorSignal("billing_error")).toBe(false);
    expect(isBillingErrorSignal(42)).toBe(false);
  });
});
