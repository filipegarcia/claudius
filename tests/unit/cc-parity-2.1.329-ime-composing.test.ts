import { describe, expect, test } from "vitest";
import { isImeComposing } from "@/lib/client/key-match";

/** CC 2.1.329 — keys that belong to an IME composition must not act on prompts, menus or dialogs. */
describe("isImeComposing", () => {
  test("a composing key, Safari's keyCode 229 and the 'Process' key are the IME's", () => {
    expect(isImeComposing({ key: "Escape", isComposing: true })).toBe(true);
    expect(isImeComposing({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: "Process" })).toBe(true);
  });
  test("an ordinary key is not", () => {
    expect(isImeComposing({ key: "Escape", isComposing: false, keyCode: 27 })).toBe(false);
    expect(isImeComposing({ key: "Enter" })).toBe(false);
  });
});
