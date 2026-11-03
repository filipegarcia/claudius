import { describe, expect, test } from "vitest";

import { isAuthFailedErrorText, isAuthFailedSignal } from "@/lib/server/auth-failed-detector";

/**
 * CC 2.1.317 — "Fixed a region or network block (HTTP 403) being shown as a
 * sign-in failure; the error now explains the block".
 *
 * The engine now answers that case with `error: "invalid_request"` (API error
 * `network_edge_blocked`) and the text below, instead of tagging it
 * `authentication_failed`. Claudius's own sign-in nudge (the auth-failed
 * banner) keys on that tag and on "401/403 + authenticat" text, so it now
 * stays quiet for the block with no code change. This pins that: widening
 * the detector to a bare "403" would send region-blocked users to sign in.
 *
 * Text copied from the 0.3.317 bundled CLI (`i2o`), with "API Error: " prefix.
 */
const REGION_BLOCK =
  "API Error: Request blocked before it reached Anthropic's API (HTTP 403) · the network this request came from isn't allowed: usually an unsupported region, or a VPN, proxy or hosting network · signing in again won't change this · check your VPN or network and retry · supported regions: https://anthropic.com/supported-countries";

describe("region / network block (HTTP 403) is not a sign-in failure", () => {
  test("the block text does not read as an auth failure", () => {
    expect(isAuthFailedErrorText(REGION_BLOCK)).toBe(false);
  });

  test("the engine's assistant error frame for the block does not fire the nudge", () => {
    expect(
      isAuthFailedSignal({
        type: "assistant",
        error: "invalid_request",
        message: { content: [{ type: "text", text: REGION_BLOCK }] },
      }),
    ).toBe(false);
  });

  test("a real 403 auth failure still does", () => {
    expect(isAuthFailedErrorText("API Error: 403 · Failed to authenticate. Check your credentials.")).toBe(true);
    expect(isAuthFailedSignal({ type: "assistant", error: "authentication_failed", message: { content: [] } })).toBe(true);
  });
});
