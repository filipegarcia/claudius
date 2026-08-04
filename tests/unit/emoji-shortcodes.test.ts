/**
 * Pin the pure logic behind the `:shortcode:` emoji autocomplete (Claude Code
 * 2.1.217 parity). Same node-only-testable split as `at-mention.ts` /
 * `slash-commands.ts`: the trigger-detection + filtering contracts live in a
 * plain `.ts` module so they're exercised without React.
 */
import { describe, expect, test } from "vitest";
import {
  EMOJI_ALIASES,
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

// CC 2.1.221 parity: "Changed emoji autocomplete to accept common alternate
// shortcodes like `:thumbsup:`, `:thumbsdown:`, and `:love:`".
describe("EMOJI_ALIASES", () => {
  test("every alias target is a real key in EMOJI_SHORTCODES", () => {
    for (const [alias, canonical] of Object.entries(EMOJI_ALIASES)) {
      expect(alias).toBe(alias.toLowerCase());
      expect(EMOJI_SHORTCODES[canonical]).toBeTruthy();
    }
  });

  test("`love` resolves to the same emoji as `heart`", () => {
    expect(lookupEmojiShortcode("love")).toBe(lookupEmojiShortcode("heart"));
  });

  test("lookup is case-insensitive for aliases too", () => {
    expect(lookupEmojiShortcode("LOVE")).toBe(EMOJI_SHORTCODES.heart);
  });

  test("filterEmojiShortcodes surfaces alias names, resolved to the canonical emoji", () => {
    const out = filterEmojiShortcodes("love");
    expect(out.some((o) => o.name === "love" && o.emoji === EMOJI_SHORTCODES.heart)).toBe(true);
  });

  test("thumbsup/thumbsdown already exist as canonical names — no alias needed", () => {
    expect(lookupEmojiShortcode("thumbsup")).toBe(EMOJI_SHORTCODES.thumbsup);
    expect(lookupEmojiShortcode("thumbsdown")).toBe(EMOJI_SHORTCODES.thumbsdown);
  });

  test("does NOT alias thumbs_up/thumbs_down — would duplicate rows in the picker for the same emoji", () => {
    // filterEmojiShortcodes has no de-dup pass, so an underscore alias for an
    // already-canonical name would surface two rows resolving to the same
    // emoji for the natural query ":thumbs". See the EMOJI_ALIASES doc
    // comment for the full rationale.
    expect(EMOJI_ALIASES.thumbs_up).toBeUndefined();
    expect(EMOJI_ALIASES.thumbs_down).toBeUndefined();
    expect(filterEmojiShortcodes("thumbs").filter((o) => o.emoji === EMOJI_SHORTCODES.thumbsup)).toHaveLength(1);
    expect(filterEmojiShortcodes("thumbs").filter((o) => o.emoji === EMOJI_SHORTCODES.thumbsdown)).toHaveLength(1);
  });
});
