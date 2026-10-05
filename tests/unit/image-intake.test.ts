import { describe, expect, test } from "vitest";
import { describeOversizedImages } from "@/lib/client/image-intake";

const MB = 1024 * 1024;

/**
 * CC 2.1.265 (D11) — an oversized image drop should name the cause instead of
 * being silently dropped.
 */
describe("describeOversizedImages (CC 2.1.265 — D11)", () => {
  test("null when nothing was over the limit", () => {
    expect(describeOversizedImages([], 20 * MB)).toBeNull();
  });

  test("names a single oversized image and the limit", () => {
    const msg = describeOversizedImages(["huge.png"], 20 * MB);
    expect(msg).toContain("huge.png");
    expect(msg).toContain("20 MB");
  });

  test("summarizes multiple oversized images", () => {
    const msg = describeOversizedImages(["a.png", "b.jpg"], 20 * MB);
    expect(msg).toContain("2 images");
    expect(msg).toContain("a.png");
    expect(msg).toContain("b.jpg");
  });
});
