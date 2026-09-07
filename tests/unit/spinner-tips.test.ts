import { describe, expect, test } from "vitest";

import { normalizeSpinnerTipsOverride } from "@/lib/server/session";

/**
 * Claude Code 2.1.247 made the rich object entry `{ id, text, cooldownSessions,
 * priority }` a canonical `spinnerTipsOverride.tips` shape alongside bare
 * strings. The prior string-only `filter` silently dropped object entries, so a
 * settings file written in the new form would lose all its tips. This pins the
 * normalization that fixes it.
 */
describe("normalizeSpinnerTipsOverride (CC 2.1.247 object-entry parity)", () => {
  test("keeps bare-string entries", () => {
    expect(
      normalizeSpinnerTipsOverride({ tips: ["one", "two"] })?.tips,
    ).toEqual(["one", "two"]);
  });

  test("maps object-form entries to their text (previously dropped)", () => {
    expect(
      normalizeSpinnerTipsOverride({
        tips: [{ id: "a", text: "from object", cooldownSessions: 3, priority: 1 }],
      })?.tips,
    ).toEqual(["from object"]);
  });

  test("accepts a mix of string and object entries", () => {
    expect(
      normalizeSpinnerTipsOverride({
        tips: ["str", { id: "x", text: "obj" }],
      })?.tips,
    ).toEqual(["str", "obj"]);
  });

  test("drops malformed entries (no text, empty, wrong type) without throwing", () => {
    expect(
      normalizeSpinnerTipsOverride({
        // @ts-expect-error — deliberately malformed runtime input
        tips: [{ id: "x" }, "", { text: "" }, 42, null, { text: "kept" }],
      })?.tips,
    ).toEqual(["kept"]);
  });

  test("threads excludeDefault", () => {
    expect(
      normalizeSpinnerTipsOverride({ excludeDefault: true, tips: ["a"] })
        ?.excludeDefault,
    ).toBe(true);
  });

  test("returns undefined for absent / non-object overrides", () => {
    expect(normalizeSpinnerTipsOverride(undefined)).toBeUndefined();
  });
});
