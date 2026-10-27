/**
 * SDK 0.3.312 added `permissions.disableAutoMode` next to the top-level
 * `disableAutoMode`. `isAutoModeDisabled` is the single predicate behind both
 * the server-side gate (`Session.setPermissionMode`) and the client picker.
 */
import { describe, expect, test } from "vitest";
import { isAutoModeDisabled } from "@/lib/shared/auto-mode-disabled";

describe("isAutoModeDisabled", () => {
  test("honours the top-level key", () => {
    expect(isAutoModeDisabled({ disableAutoMode: "disable" })).toBe(true);
  });

  test("honours the nested permissions key", () => {
    expect(isAutoModeDisabled({ permissions: { disableAutoMode: "disable" } })).toBe(true);
  });

  test("absent / empty settings leave Auto mode available", () => {
    expect(isAutoModeDisabled(undefined)).toBe(false);
    expect(isAutoModeDisabled(null)).toBe(false);
    expect(isAutoModeDisabled({})).toBe(false);
    expect(isAutoModeDisabled({ permissions: {} })).toBe(false);
    expect(isAutoModeDisabled({ permissions: null })).toBe(false);
  });

  test("mistyped values are not treated as 'disable' (the CLI skips them)", () => {
    expect(isAutoModeDisabled({ disableAutoMode: true })).toBe(false);
    expect(isAutoModeDisabled({ permissions: { disableAutoMode: true } })).toBe(false);
    expect(isAutoModeDisabled({ permissions: { disableAutoMode: "off" } })).toBe(false);
  });
});
