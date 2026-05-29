/**
 * Unit coverage for the binding → Electron accelerator conversion that
 * drives the native menu sync (Phase 3 follow-up of
 * docs/electron-conversion/PLAN.md).
 *
 * Pure functions, no DOM/Electron — exercised directly.
 */
import { describe, expect, test } from "vitest";

import {
  codeToAcceleratorToken,
  toElectronAccelerator,
  type ShortcutBinding,
} from "@/lib/client/shortcuts";

describe("codeToAcceleratorToken", () => {
  test("maps letters and digits to bare tokens", () => {
    expect(codeToAcceleratorToken("KeyT")).toBe("T");
    expect(codeToAcceleratorToken("Digit9")).toBe("9");
  });

  test("maps arrows to Electron's directional names", () => {
    expect(codeToAcceleratorToken("ArrowRight")).toBe("Right");
    expect(codeToAcceleratorToken("ArrowLeft")).toBe("Left");
  });

  test("maps punctuation used by the registry defaults", () => {
    expect(codeToAcceleratorToken("Comma")).toBe(",");
    expect(codeToAcceleratorToken("Slash")).toBe("/");
    expect(codeToAcceleratorToken("Equal")).toBe("=");
    expect(codeToAcceleratorToken("Minus")).toBe("-");
    expect(codeToAcceleratorToken("BracketRight")).toBe("]");
  });

  test("returns null for codes Electron can't name", () => {
    expect(codeToAcceleratorToken("F13")).toBeNull();
    expect(codeToAcceleratorToken("IntlBackslash")).toBeNull();
  });
});

describe("toElectronAccelerator", () => {
  test("composes mod/shift with the key token (tab.next default)", () => {
    const binding: ShortcutBinding = { mod: true, shift: true, code: "ArrowRight" };
    expect(toElectronAccelerator(binding)).toBe("CommandOrControl+Shift+Right");
  });

  test("mod maps to CommandOrControl so one string covers mac + win/linux", () => {
    expect(toElectronAccelerator({ mod: true, code: "KeyT" })).toBe("CommandOrControl+T");
  });

  test("orders modifiers mod → alt → shift", () => {
    const binding: ShortcutBinding = { mod: true, alt: true, shift: true, code: "KeyI" };
    expect(toElectronAccelerator(binding)).toBe("CommandOrControl+Alt+Shift+I");
  });

  test("returns null for a disabled (null) binding", () => {
    expect(toElectronAccelerator(null)).toBeNull();
  });

  test("returns null for a modifier-only binding (e.g. tab.selectByNumber)", () => {
    expect(toElectronAccelerator({ mod: true, shift: true, code: null })).toBeNull();
  });

  test("returns null when the key has no Electron token", () => {
    expect(toElectronAccelerator({ mod: true, code: "F13" })).toBeNull();
  });
});
