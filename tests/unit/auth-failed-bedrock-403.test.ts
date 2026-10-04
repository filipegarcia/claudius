import { describe, expect, test } from "vitest";
import { isAuthFailedErrorText, isAuthFailedSignal } from "@/lib/server/auth-failed-detector";

/**
 * CC 2.1.273 (E14) — a Bedrock/Vertex/Foundry or gateway credential failure
 * surfaces as 403 (and as the `cloud_credential_error` structured tag), not
 * just the Anthropic-direct 401. Both now fire the auth-failed nudge.
 */
describe("auth-failed detector — Bedrock/gateway 403 (E14)", () => {
  test("a 403 + authentication text now matches (was 401-only)", () => {
    expect(isAuthFailedErrorText("API Error: 403 Forbidden — authentication failed")).toBe(true);
  });

  test("401 + authentication still matches", () => {
    expect(isAuthFailedErrorText("API Error: 401 — authentication error")).toBe(true);
  });

  test("a bare 403 with no auth language does NOT match (keeps the radius small)", () => {
    expect(isAuthFailedErrorText("HTTP 403 while fetching https://x/403")).toBe(false);
  });

  test("the structured cloud_credential_error tag fires the nudge", () => {
    expect(isAuthFailedSignal({ type: "assistant", error: "cloud_credential_error" })).toBe(true);
    expect(isAuthFailedSignal({ type: "assistant", error: "authentication_failed" })).toBe(true);
  });

  test("an unrelated error tag does not fire", () => {
    expect(isAuthFailedSignal({ type: "assistant", error: "server_error" })).toBe(false);
  });
});
