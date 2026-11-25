import { describe, expect, test } from "vitest";

import { isHistoryRecallKey } from "@/lib/shared/prompt-history";

/**
 * CC 2.1.331 parity — "[VSCode] Fixed the arrow keys replacing typed text with
 * an old prompt while selecting". ⌘⇧↑/↓ (Ctrl+Shift+↑/↓) selects text; only a
 * plain Cmd/Ctrl+↑/↓ walks prompt history.
 */
const k = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

describe("isHistoryRecallKey (CC 2.1.331)", () => {
  test("Cmd/Ctrl+↑/↓ with no selection walks history, as before", () => {
    expect(isHistoryRecallKey(k("ArrowUp", { metaKey: true }), false)).toBe(true);
    expect(isHistoryRecallKey(k("ArrowDown", { ctrlKey: true }), false)).toBe(true);
  });

  test("⌘⇧↑ / Ctrl+Shift+↓ select instead of replacing the draft", () => {
    expect(isHistoryRecallKey(k("ArrowUp", { metaKey: true, shiftKey: true }), false)).toBe(false);
    expect(isHistoryRecallKey(k("ArrowDown", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  test("a selection in progress keeps its arrow keys", () => {
    expect(isHistoryRecallKey(k("ArrowUp", { metaKey: true }), true)).toBe(false);
  });

  test("plain arrows and other keys are not the recall chord", () => {
    expect(isHistoryRecallKey(k("ArrowUp", {}), false)).toBe(false);
    expect(isHistoryRecallKey(k("ArrowLeft", { metaKey: true }), false)).toBe(false);
  });
});
