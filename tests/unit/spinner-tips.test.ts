import { describe, expect, test } from "vitest";

import { normalizeSpinnerTipsOverride } from "@/lib/server/session";

/**
 * Claude Code 2.1.247 made the rich object entry `{ id, text, cooldownSessions,
 * priority }` a canonical `spinnerTipsOverride.tips` shape alongside bare
 * strings. G6: the normalizer now PRESERVES each entry's shape (so `selectTips`
 * can honor id/priority/cooldownSessions) and threads `label` + `tipsFile`,
 * rather than flattening everything to text-only strings.
 */
describe("normalizeSpinnerTipsOverride (CC 2.1.247 / G6)", () => {
  test("keeps bare-string entries (trimmed)", () => {
    expect(normalizeSpinnerTipsOverride({ tips: ["one", " two "] })?.tips).toEqual(["one", "two"]);
  });

  test("preserves object-form entries with their fields (previously flattened)", () => {
    expect(
      normalizeSpinnerTipsOverride({
        tips: [{ id: "a", text: "from object", cooldownSessions: 3, priority: 1 }],
      })?.tips,
    ).toEqual([{ id: "a", text: "from object", cooldownSessions: 3, priority: 1 }]);
  });

  test("accepts a mix of string and object entries", () => {
    expect(
      normalizeSpinnerTipsOverride({ tips: ["str", { id: "x", text: "obj" }] })?.tips,
    ).toEqual(["str", { id: "x", text: "obj" }]);
  });

  test("drops malformed entries (no text, empty, wrong type) without throwing", () => {
    expect(
      normalizeSpinnerTipsOverride({
        // @ts-expect-error — deliberately malformed runtime input
        tips: [{ id: "x" }, "", { text: "" }, 42, null, { text: "kept" }],
      })?.tips,
    ).toEqual([{ text: "kept" }]);
  });

  test("threads excludeDefault, label and tipsFile", () => {
    const n = normalizeSpinnerTipsOverride({
      excludeDefault: true,
      tips: ["a"],
      label: "Team",
      tipsFile: "~/tips.json",
    });
    expect(n?.excludeDefault).toBe(true);
    expect(n?.label).toBe("Team");
    expect(n?.tipsFile).toBe("~/tips.json");
  });

  test("returns undefined for absent / non-object overrides", () => {
    expect(normalizeSpinnerTipsOverride(undefined)).toBeUndefined();
  });
});
