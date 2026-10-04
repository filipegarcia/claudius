import { describe, expect, test } from "vitest";
import { attributionFieldState } from "@/lib/shared/attribution-setting";

/**
 * CC 2.1.281 (F7) — the `attribution` catalog toggle's three states.
 */
describe("attributionFieldState (F7)", () => {
  test("false → hidden", () => {
    expect(attributionFieldState(false)).toBe("hidden");
  });

  test("an object config → custom (toggle steps aside)", () => {
    expect(attributionFieldState({ commit: "" })).toBe("custom");
    expect(attributionFieldState({ pr: "x", sessionUrl: false })).toBe("custom");
    expect(attributionFieldState({})).toBe("custom");
  });

  test("true / unset → default (true is 'same as leaving it out')", () => {
    expect(attributionFieldState(true)).toBe("default");
    expect(attributionFieldState(undefined)).toBe("default");
  });

  test("null and unexpected scalars fall back to default (not custom)", () => {
    expect(attributionFieldState(null)).toBe("default");
    expect(attributionFieldState("false")).toBe("default");
    expect(attributionFieldState(0)).toBe("default");
  });
});
