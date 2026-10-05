import { describe, expect, test } from "vitest";
import { capRecap, RECAP_MAX_CHARS } from "@/lib/shared/recap-cap";

/**
 * CC 2.1.236 (H8) — recaps are capped at 400 chars on a word boundary.
 */
describe("capRecap (H8)", () => {
  test("short text is unchanged", () => {
    expect(capRecap("A short recap.")).toBe("A short recap.");
  });

  test("caps at the word boundary with an ellipsis, within the limit", () => {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const out = capRecap(text);
    expect(out.length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    // No token was cut mid-word: the char before the ellipsis ends a full word.
    expect(/word\d+…$/.test(out)).toBe(true);
  });

  test("respects a custom max", () => {
    const out = capRecap("alpha beta gamma delta epsilon", 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("alpha beta…");
  });

  test("hard-cuts a single giant token (no usable space)", () => {
    const out = capRecap("x".repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});
