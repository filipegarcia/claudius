import { beforeEach, describe, expect, test } from "vitest";

import {
  armPrompt,
  FIELD_TYPING_LOOKBACK_MS,
  isEscapeMeantForField,
  isTextField,
  noteFieldKeydown,
  notePointerdown,
  PROMPT_ARM_GRACE_MS,
  resetPromptArmStateForTests,
  shouldIgnorePromptEscape,
} from "@/lib/client/prompt-arm";

/**
 * CC 2.1.327 parity — "Fixed Esc being ignored on a permission prompt that
 * had just appeared." The 2.1.318 grace window used to drop every Escape in
 * the first 400ms; now it only drops one when the user was typing in a text
 * field as the prompt armed. A deliberate Esc — including the second of two
 * quick Escs through queued prompts — answers.
 *
 * Mirrors the components: the window capture listener (`noteFieldKeydown`)
 * sees each keydown before the prompt's bubble listener
 * (`shouldIgnorePromptEscape`); answering a prompt mounts the next queued
 * one at once (disarm, then arm).
 */
const composer = { tagName: "TEXTAREA", value: "" };
const body = { tagName: "BODY" };

/** One Escape through capture → the open prompt's guard. True = answered. */
function pressEscape(timeStamp: number, armedAt: number, target: unknown = composer): boolean {
  noteFieldKeydown({ key: "Escape", timeStamp, target });
  return !shouldIgnorePromptEscape({ timeStamp }, armedAt);
}

beforeEach(() => resetPromptArmStateForTests());

describe("deliberate Esc on a fresh prompt", () => {
  test("with no recent typing, a quick Esc denies", () => {
    armPrompt();
    expect(pressEscape(5050, 5000)).toBe(true);
    expect(pressEscape(5050, 5000, body)).toBe(true);
  });

  test("typing long before the prompt armed doesn't hold the Esc back", () => {
    noteFieldKeydown({ key: "Enter", timeStamp: 1000, target: composer });
    const armedAt = 1000 + FIELD_TYPING_LOOKBACK_MS + 1;
    armPrompt();
    expect(pressEscape(armedAt + 50, armedAt)).toBe(true);
  });

  test("keys outside a text field aren't typing evidence", () => {
    noteFieldKeydown({ key: "a", timeStamp: 4900, target: body });
    noteFieldKeydown({ key: "Enter", timeStamp: 4950, target: { tagName: "BUTTON" } });
    noteFieldKeydown({ key: "x", timeStamp: 4960, target: { tagName: "INPUT", type: "checkbox" } });
    armPrompt();
    expect(pressEscape(5050, 5000)).toBe(true);
  });

  test("modifier keys alone aren't typing evidence", () => {
    noteFieldKeydown({ key: "Shift", timeStamp: 4950, target: composer });
    armPrompt();
    expect(pressEscape(5050, 5000)).toBe(true);
  });
});

describe("Esc meant for the composer is still held back", () => {
  test("composer typing just before the prompt, then Esc within grace, is suppressed", () => {
    noteFieldKeydown({ key: "/", timeStamp: 4800, target: composer });
    armPrompt();
    expect(pressEscape(5000 + PROMPT_ARM_GRACE_MS - 1, 5000)).toBe(false);
  });

  test("the lookback boundary counts as typing", () => {
    noteFieldKeydown({ key: "Enter", timeStamp: 5000 - FIELD_TYPING_LOOKBACK_MS, target: composer });
    armPrompt();
    expect(pressEscape(5100, 5000)).toBe(false);
  });

  test("typing after the prompt armed, then Esc within grace, is suppressed", () => {
    armPrompt();
    noteFieldKeydown({ key: "a", timeStamp: 5100, target: composer });
    expect(pressEscape(5200, 5000)).toBe(false);
  });

  test("past the grace window the same Esc denies", () => {
    noteFieldKeydown({ key: "a", timeStamp: 4900, target: composer });
    armPrompt();
    expect(pressEscape(5000 + PROMPT_ARM_GRACE_MS, 5000)).toBe(true);
  });

  test("an empty composer still counts (Enter just sent the message)", () => {
    expect(isTextField(composer)).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "text", value: "" })).toBe(true);
    expect(isTextField({ tagName: "DIV", isContentEditable: true, textContent: "" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("two queued prompts, Esc twice quickly", () => {
  test("both deny, even right after sending a message", () => {
    // The user sends, the first prompt appears soon after.
    noteFieldKeydown({ key: "Enter", timeStamp: 1000, target: composer });
    let disarm = armPrompt();
    const firstArmedAt = 1300;
    // An Esc this quick on the first prompt still reads as composer typing…
    expect(pressEscape(firstArmedAt + 100, firstArmedAt)).toBe(false);
    // …but once the user has looked at it, Esc denies.
    expect(pressEscape(firstArmedAt + PROMPT_ARM_GRACE_MS + 50, firstArmedAt)).toBe(true);
    // Answering mounts the queued second prompt at once.
    disarm();
    disarm = armPrompt();
    const secondArmedAt = firstArmedAt + PROMPT_ARM_GRACE_MS + 60;
    // The first Esc (composer-focused, on an open prompt) wasn't typing.
    expect(pressEscape(secondArmedAt + 80, secondArmedAt)).toBe(true);
    disarm();
  });

  test("both deny with no prior typing", () => {
    let disarm = armPrompt();
    expect(pressEscape(1050, 1000)).toBe(true);
    disarm();
    disarm = armPrompt();
    expect(pressEscape(1120, 1060)).toBe(true);
    disarm();
  });

  test("clicking Allow on the first prompt clears the typing evidence for the second", () => {
    noteFieldKeydown({ key: "Enter", timeStamp: 1000, target: composer });
    let disarm = armPrompt();
    notePointerdown();
    disarm();
    disarm = armPrompt();
    expect(pressEscape(1250, 1200)).toBe(true);
    disarm();
  });

  test("a click with no prompt open doesn't clear the evidence", () => {
    noteFieldKeydown({ key: "a", timeStamp: 1000, target: composer });
    notePointerdown();
    armPrompt();
    expect(pressEscape(1250, 1200)).toBe(false);
  });

  test("a StrictMode-style arm/disarm/arm keeps the evidence and the open count", () => {
    noteFieldKeydown({ key: "a", timeStamp: 1000, target: composer });
    const first = armPrompt();
    first();
    first(); // idempotent
    armPrompt();
    expect(pressEscape(1250, 1200)).toBe(false);
  });

  test("the pure rule: no typing evidence means a fresh-prompt Esc answers", () => {
    expect(isEscapeMeantForField(1050, 1000, null)).toBe(false);
  });
});
