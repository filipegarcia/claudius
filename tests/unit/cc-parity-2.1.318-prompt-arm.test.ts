import { describe, expect, test } from "vitest";

import { isBeforePromptArmed, PROMPT_ARM_GRACE_MS } from "@/lib/client/prompt-arm";

/**
 * CC 2.1.318 parity — "Fixed permission prompts being answered by keys typed
 * just after sending a message, or before a slow prompt appeared". The
 * permission card's / MCP prompt's window-level Escape (deny / cancel)
 * ignores keystrokes inside a short arm window after the prompt appears.
 */
describe("isBeforePromptArmed", () => {
  test("a keystroke before the prompt armed (or not armed yet) is ignored", () => {
    expect(isBeforePromptArmed(1000, null)).toBe(true);
    expect(isBeforePromptArmed(999, 1000)).toBe(true);
  });

  test("a keystroke inside the grace window is ignored", () => {
    expect(isBeforePromptArmed(1000 + PROMPT_ARM_GRACE_MS - 1, 1000)).toBe(true);
  });

  test("a keystroke after the grace window answers the prompt as before", () => {
    expect(isBeforePromptArmed(1000 + PROMPT_ARM_GRACE_MS, 1000)).toBe(false);
    expect(isBeforePromptArmed(1000 + 5000, 1000)).toBe(false);
  });

  test("the window is short enough not to feel laggy", () => {
    expect(PROMPT_ARM_GRACE_MS).toBeGreaterThanOrEqual(200);
    expect(PROMPT_ARM_GRACE_MS).toBeLessThanOrEqual(600);
  });
});
