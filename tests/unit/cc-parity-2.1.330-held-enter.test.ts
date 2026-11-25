import { describe, expect, test } from "vitest";

import { isHeldRepeat } from "@/lib/client/composer-keys";

/**
 * CC 2.1.330 parity — "[VSCode] Fixed a held-down Enter key sending a
 * half-written message or running a typed slash command". The composer and
 * the `@` / `/` / `:` pickers ignore Enter and Tab auto-repeats.
 */
describe("isHeldRepeat (CC 2.1.330)", () => {
  test("an auto-repeated Enter or Tab is a held repeat", () => {
    expect(isHeldRepeat({ key: "Enter", repeat: true })).toBe(true);
    expect(isHeldRepeat({ key: "Tab", repeat: true })).toBe(true);
  });

  test("a fresh press still picks or sends", () => {
    expect(isHeldRepeat({ key: "Enter", repeat: false })).toBe(false);
    expect(isHeldRepeat({ key: "Enter" })).toBe(false);
    expect(isHeldRepeat({ key: "Tab", repeat: false })).toBe(false);
  });

  test("other held keys (arrows, letters) keep repeating", () => {
    expect(isHeldRepeat({ key: "ArrowDown", repeat: true })).toBe(false);
    expect(isHeldRepeat({ key: "a", repeat: true })).toBe(false);
  });
});
