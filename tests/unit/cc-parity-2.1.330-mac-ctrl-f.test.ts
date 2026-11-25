import { describe, expect, test } from "vitest";

import { isFindChord } from "@/lib/client/composer-keys";

/**
 * CC 2.1.330 parity — "[VSCode] Fixed Ctrl+F and Ctrl+P not moving the caret
 * in the message box on macOS". Ctrl+F is macOS's "forward one character" in
 * text fields, so there it no longer opens the transcript find bar.
 */
const key = (mods: { ctrlKey?: boolean; metaKey?: boolean }) => ({
  key: "f",
  code: "KeyF",
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe("isFindChord (CC 2.1.330)", () => {
  test("macOS, typing in the message box: Ctrl+F is left to move the caret", () => {
    expect(isFindChord(key({ ctrlKey: true }), { mac: true, typing: true })).toBe(false);
  });

  test("macOS, typing: Cmd+F still opens find", () => {
    expect(isFindChord(key({ metaKey: true }), { mac: true, typing: true })).toBe(true);
  });

  test("macOS, not in a text field: Ctrl+F and Cmd+F open find as before", () => {
    expect(isFindChord(key({ ctrlKey: true }), { mac: true, typing: false })).toBe(true);
    expect(isFindChord(key({ metaKey: true }), { mac: true, typing: false })).toBe(true);
  });

  test("Windows/Linux: Ctrl+F opens find even while typing", () => {
    expect(isFindChord(key({ ctrlKey: true }), { mac: false, typing: true })).toBe(true);
  });

  test("a bare F, or another letter, is not the find chord", () => {
    expect(isFindChord(key({}), { mac: false, typing: false })).toBe(false);
    expect(isFindChord({ ...key({ ctrlKey: true }), key: "g", code: "KeyG" }, { mac: false, typing: false })).toBe(false);
  });

  test("non-Latin layouts still match by physical key (CC 2.1.314)", () => {
    expect(isFindChord({ key: "а", code: "KeyF", ctrlKey: true, metaKey: false }, { mac: false, typing: true })).toBe(true);
  });
});
