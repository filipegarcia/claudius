import { describe, expect, it } from "vitest";
import { stripInvisibleUnicode } from "@/lib/shared/invisible-unicode";

describe("stripInvisibleUnicode", () => {
  it("removes zero-width space, word joiner, and BOM", () => {
    const { cleaned, removedCount } = stripInvisibleUnicode("hi​there⁠﻿!");
    expect(cleaned).toBe("hithere!");
    expect(removedCount).toBe(3);
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

  it("preserves the zero-width joiner (U+200D) so emoji ZWJ sequences survive intact", () => {
    // "woman technologist" — U+1F469 U+200D U+1F4BB. An earlier draft
    // stripped ZWJ unconditionally, which split this into two separate
    // emoji and fired a false "hidden characters" notice.
    const emoji = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
    const { cleaned, removedCount } = stripInvisibleUnicode(emoji);
    expect(cleaned).toBe(emoji);
    expect(removedCount).toBe(0);
  });

  it("leaves ordinary text untouched", () => {
    const { cleaned, removedCount } = stripInvisibleUnicode("plain ascii text 123 — em dash");
    expect(cleaned).toBe("plain ascii text 123 — em dash");
    expect(removedCount).toBe(0);
  });
});
