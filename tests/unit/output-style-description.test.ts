import { describe, expect, test } from "vitest";
import { STATIC_OUTPUT_STYLES, outputStyleDescription } from "@/lib/shared/output-styles";

/**
 * CC 2.1.286 (D13) — the /output-style picker shows a description under each
 * name. The SDK gives names only, so built-in descriptions come from here.
 */
describe("outputStyleDescription (CC 2.1.286 — D13)", () => {
  test("every built-in style has a non-empty description", () => {
    for (const style of STATIC_OUTPUT_STYLES) {
      expect(outputStyleDescription(style).length).toBeGreaterThan(0);
    }
  });

  test("built-ins are distinct, not the generic fallback", () => {
    expect(outputStyleDescription("explanatory")).toContain("educational");
    expect(outputStyleDescription("concise")).not.toBe(outputStyleDescription("developer"));
  });

  test("an unknown/plugin style falls back to a generic line", () => {
    expect(outputStyleDescription("my-plugin-style")).toBe("Custom output style.");
  });
});
