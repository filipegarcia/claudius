import { describe, expect, test } from "vitest";
import { keybindingKeyWarning } from "@/lib/shared/keybinding-keys";

/**
 * CC 2.1.293 — "a lone " " (space key) is no longer reported as an error, and
 * keys like "ctrl+ k" now get a warning".
 */
describe("keybindingKeyWarning (CC 2.1.293)", () => {
  test("warns on whitespace next to a + between two keys, with the fixed form", () => {
    expect(keybindingKeyWarning("ctrl+ k")).toBe('"ctrl+ k" has a space next to "+" — write it as "ctrl+k".');
    expect(keybindingKeyWarning("ctrl +k")).toContain('write it as "ctrl+k"');
    expect(keybindingKeyWarning("ctrl + shift + p")).toContain('write it as "ctrl+shift+p"');
  });

  test("a lone space is the space key, and a trailing space after + names ctrl+space", () => {
    expect(keybindingKeyWarning(" ")).toBeNull();
    expect(keybindingKeyWarning("ctrl+ ")).toBeNull();
  });

  test("well-formed and empty keys get no warning", () => {
    for (const key of ["ctrl+k", "shift+tab", "escape", "", undefined]) {
      expect(keybindingKeyWarning(key)).toBeNull();
    }
  });
});
