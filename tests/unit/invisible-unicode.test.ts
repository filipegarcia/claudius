import { describe, expect, it } from "vitest";
import { containsInvisibleUnicode, stripInvisibleUnicode } from "@/lib/shared/invisible-unicode";

describe("stripInvisibleUnicode", () => {
  it("removes zero-width formatting characters", () => {
    const { cleaned, removedCount } = stripInvisibleUnicode("hi​there‍⁠﻿!");
    expect(cleaned).toBe("hithere!");
    expect(removedCount).toBe(4);
  });

  it("removes bidi control characters", () => {
    const { cleaned, removedCount } = stripInvisibleUnicode("a‮b‪c⁦d⁩e");
    expect(cleaned).toBe("abcde");
    expect(removedCount).toBe(4);
  });

  it("removes Unicode tag characters used for steganographic smuggling", () => {
    // U+E0041 U+E0042 U+E0043 spell "ABC" invisibly in the tag block.
    const hidden = "visible" + String.fromCodePoint(0xe0041, 0xe0042, 0xe0043);
    const { cleaned, removedCount } = stripInvisibleUnicode(hidden);
    expect(cleaned).toBe("visible");
    expect(removedCount).toBe(3);
  });

  it("preserves the zero-width non-joiner (U+200C)", () => {
    // Persian/Arabic suffix attachment relies on ZWNJ — must survive, per
    // the sibling CLI fix in the same 2.1.280 release.
    const text = "پدف‌ها"; // "پدف‌ها" (PDFs)
    const { cleaned, removedCount } = stripInvisibleUnicode(text);
    expect(cleaned).toBe(text);
    expect(removedCount).toBe(0);
  });

  it("leaves ordinary text untouched", () => {
    const { cleaned, removedCount } = stripInvisibleUnicode("plain ascii text 123 — em dash");
    expect(cleaned).toBe("plain ascii text 123 — em dash");
    expect(removedCount).toBe(0);
  });
});

describe("containsInvisibleUnicode", () => {
  it("returns true when an invisible character is present", () => {
    expect(containsInvisibleUnicode("hi​there")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsInvisibleUnicode("hi there")).toBe(false);
  });

  it("returns false when only the preserved ZWNJ is present", () => {
    expect(containsInvisibleUnicode("a‌b")).toBe(false);
  });
});
