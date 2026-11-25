import { describe, expect, test } from "vitest";

import { answerDigitIndex } from "@/lib/client/question-keys";

/**
 * CC 2.1.331 — "[VSCode] Fixed shortcuts such as Ctrl+1, Alt+1 or Ctrl+Space
 * answering an open dialog, which could restore files in the rewind
 * confirmation or switch the git branch".
 *
 * Claudius's question modal picked option N for any keydown whose `key` was
 * the digit N, chords included — so Ctrl+Alt+N ("Go to workspace N") or
 * Ctrl+1 on macOS changed the selected answer. Only a bare digit picks now.
 * (Claudius's restore-files and branch dialogs have no digit keys.)
 */
const bare = { metaKey: false, ctrlKey: false, altKey: false };

describe("answerDigitIndex", () => {
  test("a bare digit picks that option", () => {
    expect(answerDigitIndex({ key: "1", ...bare }, 3)).toBe(0);
    expect(answerDigitIndex({ key: "3", ...bare }, 3)).toBe(2);
  });

  test("a digit past the last option picks nothing", () => {
    expect(answerDigitIndex({ key: "4", ...bare }, 3)).toBeNull();
  });

  test("Ctrl, Alt or Cmd with a digit picks nothing", () => {
    expect(answerDigitIndex({ key: "1", ...bare, ctrlKey: true }, 3)).toBeNull();
    expect(answerDigitIndex({ key: "1", ...bare, altKey: true }, 3)).toBeNull();
    expect(answerDigitIndex({ key: "1", ...bare, metaKey: true }, 3)).toBeNull();
    expect(answerDigitIndex({ key: "2", ...bare, ctrlKey: true, altKey: true }, 3)).toBeNull();
  });

  test("non-digit keys pick nothing", () => {
    expect(answerDigitIndex({ key: "0", ...bare }, 3)).toBeNull();
    expect(answerDigitIndex({ key: " ", ...bare, ctrlKey: true }, 3)).toBeNull();
    expect(answerDigitIndex({ key: "a", ...bare }, 3)).toBeNull();
  });
});
