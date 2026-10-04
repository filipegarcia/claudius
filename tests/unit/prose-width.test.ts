import { describe, expect, test } from "vitest";
import { MIN_PROSE_WIDTH_COLS, proseMaxWidthCss } from "@/lib/client/prose-width";

/**
 * CC 2.1.282 (F3) — `maxProseWidth` → a `ch` cap for `--prose-max-width`.
 */
describe("proseMaxWidthCss (F3)", () => {
  test("a valid column count becomes a ch length", () => {
    expect(proseMaxWidthCss(80)).toBe("80ch");
    expect(proseMaxWidthCss(120)).toBe("120ch");
  });

  test("values below the minimum clamp up to 40", () => {
    expect(proseMaxWidthCss(10)).toBe(`${MIN_PROSE_WIDTH_COLS}ch`);
    expect(proseMaxWidthCss(1)).toBe("40ch");
    expect(proseMaxWidthCss(40)).toBe("40ch");
  });

  test("fractional counts round to whole columns", () => {
    expect(proseMaxWidthCss(80.4)).toBe("80ch");
    expect(proseMaxWidthCss(80.6)).toBe("81ch");
  });

  test("numeric strings are accepted (settings.json is hand-editable)", () => {
    expect(proseMaxWidthCss("100")).toBe("100ch");
    expect(proseMaxWidthCss("  72 ")).toBe("72ch");
  });

  test("unset / invalid / non-positive → null (no cap)", () => {
    expect(proseMaxWidthCss(undefined)).toBeNull();
    expect(proseMaxWidthCss(null)).toBeNull();
    expect(proseMaxWidthCss(0)).toBeNull();
    expect(proseMaxWidthCss(-20)).toBeNull();
    expect(proseMaxWidthCss(Number.NaN)).toBeNull();
    expect(proseMaxWidthCss(Number.POSITIVE_INFINITY)).toBeNull();
    expect(proseMaxWidthCss("")).toBeNull();
    expect(proseMaxWidthCss("wide")).toBeNull();
    expect(proseMaxWidthCss({})).toBeNull();
  });
});
