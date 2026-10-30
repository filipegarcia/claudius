import { describe, expect, test } from "vitest";
import { isLetterKey } from "@/lib/client/key-match";

/**
 * CC 2.1.314 — "[VSCode] Fixed the voice dictation shortcut (Ctrl+D) doing
 * nothing under non-Latin keyboard layouts such as Russian, Greek or Hebrew".
 * Claudius's ad-hoc letter shortcuts (Ctrl+C in the composer, Cmd/Ctrl+F/G/S,
 * …) matched on `event.key`, which is the layout's character.
 */
describe("isLetterKey", () => {
  test("US layout: key and code agree", () => {
    expect(isLetterKey({ key: "c", code: "KeyC" }, "c")).toBe(true);
    expect(isLetterKey({ key: "C", code: "KeyC" }, "c")).toBe(true); // Shift
  });

  test.each([
    ["Russian", "с"],
    ["Greek", "ψ"],
    ["Hebrew", "ב"],
  ])("%s layout: falls back to the physical key", (_layout, key) => {
    expect(isLetterKey({ key, code: "KeyC" }, "c")).toBe(true);
    expect(isLetterKey({ key, code: "KeyX" }, "c")).toBe(false);
  });

  test("Dvorak keeps its mnemonic letter (no regression to physical keys)", () => {
    // Dvorak's "c" sits on the physical I key; its physical C types "j".
    expect(isLetterKey({ key: "c", code: "KeyI" }, "c")).toBe(true);
    expect(isLetterKey({ key: "j", code: "KeyC" }, "c")).toBe(false);
  });

  test("non-character keys never match a letter", () => {
    expect(isLetterKey({ key: "Enter", code: "Enter" }, "c")).toBe(false);
    expect(isLetterKey({ key: "Control", code: "ControlLeft" }, "c")).toBe(false);
  });
});
