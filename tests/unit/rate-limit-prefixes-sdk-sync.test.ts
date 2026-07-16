import { describe, expect, test } from "vitest";
import { USAGE_LIMIT_ERROR_PREFIXES as SDK_USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { USAGE_LIMIT_ERROR_PREFIXES } from "@/lib/shared/rate-limit-prefixes";

/**
 * `lib/shared/rate-limit-prefixes.ts` holds a hand-copied literal of the
 * SDK's `@alpha` `USAGE_LIMIT_ERROR_PREFIXES` export (see that file's doc
 * comment for why it can't just import the SDK's value — the SDK's main
 * entry is Node-only and would break the client bundle).
 *
 * This test is the thing that makes that copy safe: it imports the *real*
 * SDK export directly (fine here — vitest runs under Node, unlike
 * `lib/client/`) and asserts our copy matches it exactly, element-for-
 * element, ordering included. If a future SDK bump adds, removes, reorders,
 * or reword a prefix, this fails loudly instead of the copy silently
 * drifting out of sync with what the CLI actually emits.
 */
describe("USAGE_LIMIT_ERROR_PREFIXES stays in sync with the SDK", () => {
  test("our shared copy exactly matches the SDK's exported list", () => {
    expect(USAGE_LIMIT_ERROR_PREFIXES).toEqual(SDK_USAGE_LIMIT_ERROR_PREFIXES);
  });
});
