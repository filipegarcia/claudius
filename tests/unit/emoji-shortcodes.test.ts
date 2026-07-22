/**
 * Pin the pure logic behind the `:shortcode:` emoji autocomplete (Claude Code
 * 2.1.217 parity). Same node-only-testable split as `at-mention.ts` /
 * `slash-commands.ts`: the trigger-detection + filtering contracts live in a
 * plain `.ts` module so they're exercised without React.
 */
import { describe, expect, test } from "vitest";
import {
  EMOJI_PICKER_LIMIT,
  EMOJI_SHORTCODES,
  filterEmojiShortcodes,
  lookupEmojiShortcode,
  parseEmojiTrigger,
} from "@/lib/shared/emoji-shortcodes";

describe("parseEmojiTrigger", () => {
  test("detects an open `:shortcode` token at the end of the string", () => {
    expect(parseEmojiTrigger(":hea")).toBe("hea");
  });

  test("detects an open token after whitespace", () => {
    expect(parseEmojiTrigger("nice :fir")).toBe("fir");
  });

  test("an empty query right after the colon is still a trigger (shows the full list)", () => {
    expect(parseEmojiTrigger("hello :")).toBe("");
  });

  test("a mid-word colon is NOT a trigger (e.g. a URL scheme)", () => {
    expect(parseEmojiTrigger("http:")).toBeNull();
  });

  test("a clock-style colon is NOT a trigger (digit immediately before the colon)", () => {
    expect(parseEmojiTrigger("it's 10:3")).toBeNull();
  });

  test("no colon at all yields null", () => {
    expect(parseEmojiTrigger("just text")).toBeNull();
  });

  test("a space after the shortcode name closes the token (no longer trailing)", () => {
    expect(parseEmojiTrigger(":heart ")).toBeNull();
  });
});

describe("filterEmojiShortcodes", () => {
  test("prefix matches sort before substring matches", () => {
    const out = filterEmojiShortcodes("heart");
    const names = out.map((o) => o.name);
    // "heart" itself is an exact prefix match; "sparkling_heart" etc. only
    // contain "heart" partway through and must sort after every prefix match.
    const heartIdx = names.indexOf("heart");
    const sparklingIdx = names.indexOf("sparkling_heart");
    expect(heartIdx).toBeGreaterThanOrEqual(0);
    expect(sparklingIdx).toBeGreaterThan(heartIdx);
  });

  test("is case-insensitive", () => {
    expect(filterEmojiShortcodes("HEART").some((o) => o.name === "heart")).toBe(true);
  });

  test("an empty query returns results (capped), not everything unbounded", () => {
    const out = filterEmojiShortcodes("");
    expect(out.length).toBeLessThanOrEqual(EMOJI_PICKER_LIMIT);
    expect(out.length).toBeGreaterThan(0);
  });

  test("a non-match yields an empty list", () => {
    expect(filterEmojiShortcodes("zzzznotarealshortcode")).toEqual([]);
  });

  test(`caps the result at EMOJI_PICKER_LIMIT (${EMOJI_PICKER_LIMIT})`, () => {
    // "e" is common enough across the curated table to exceed the cap.
    const out = filterEmojiShortcodes("e");
    expect(out.length).toBeLessThanOrEqual(EMOJI_PICKER_LIMIT);
  });

  test("every table entry is a single emoji-bearing string", () => {
    for (const [name, emoji] of Object.entries(EMOJI_SHORTCODES)) {
      expect(name).toBe(name.toLowerCase());
      expect(typeof emoji).toBe("string");
      expect(emoji.length).toBeGreaterThan(0);
    }
  });
});

describe("lookupEmojiShortcode", () => {
  test("resolves a known shortcode to its emoji", () => {
    expect(lookupEmojiShortcode("heart")).toBe("❤️");
  });

  test("is case-insensitive", () => {
    expect(lookupEmojiShortcode("HEART")).toBe("❤️");
  });

  test("returns undefined for an unknown shortcode", () => {
    expect(lookupEmojiShortcode("not_a_real_emoji_name")).toBeUndefined();
  });
});
