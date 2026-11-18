import { beforeEach, describe, expect, test } from "vitest";

import {
  armPrompt,
  isEscapeMeantForField,
  noteFieldKeydown,
  PROMPT_ARM_GRACE_MS,
  resetPromptArmStateForTests,
  shouldIgnorePromptEscape,
} from "@/lib/client/prompt-arm";

/**
 * CC 2.1.318 parity — "Fixed permission prompts being answered by keys typed
 * just after sending a message, or before a slow prompt appeared". The
 * permission card's / MCP prompt's window-level Escape (deny / cancel)
 * ignores an Escape inside a short arm window after the prompt appears when
 * the user was typing in the composer (narrowed in 2.1.327 so a deliberate
 * Esc still answers — see cc-parity-2.1.327-prompt-esc.test.ts).
 */
const composer = { tagName: "TEXTAREA", value: "" };

describe("isEscapeMeantForField", () => {
  test("a keystroke before the prompt armed (not armed yet) is ignored", () => {
    expect(isEscapeMeantForField(1000, null, null)).toBe(true);
  });

  test("an Escape inside the grace window after composer typing is ignored", () => {
    expect(isEscapeMeantForField(1000 + PROMPT_ARM_GRACE_MS - 1, 1000, 900)).toBe(true);
    expect(isEscapeMeantForField(999, 1000, 900)).toBe(true);
  });

  test("a keystroke after the grace window answers the prompt as before", () => {
    expect(isEscapeMeantForField(1000 + PROMPT_ARM_GRACE_MS, 1000, 900)).toBe(false);
    expect(isEscapeMeantForField(1000 + 5000, 1000, 1200)).toBe(false);
  });

  test("the window is short enough not to feel laggy", () => {
    expect(PROMPT_ARM_GRACE_MS).toBeGreaterThanOrEqual(200);
    expect(PROMPT_ARM_GRACE_MS).toBeLessThanOrEqual(600);
  });
});

describe("Escape typed for the composer as a slow prompt appears", () => {
  beforeEach(() => resetPromptArmStateForTests());

  test("Enter sends, prompt appears, a quick Escape does not deny it unseen", () => {
    noteFieldKeydown({ key: "Enter", timeStamp: 1000, target: composer });
    armPrompt();
    expect(shouldIgnorePromptEscape({ timeStamp: 1500 + 100 }, 1500)).toBe(true);
  });

  test("two Escapes clear the input: the second, landing on a fresh prompt, is ignored", () => {
    noteFieldKeydown({ key: "Escape", timeStamp: 1000, target: { tagName: "TEXTAREA", value: "draft" } });
    armPrompt();
    expect(shouldIgnorePromptEscape({ timeStamp: 1150 }, 1100)).toBe(true);
  });
});
