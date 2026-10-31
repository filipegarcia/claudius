import { describe, expect, test } from "vitest";

import {
  OPUS48_FAST_DEPRECATION_KEY,
  OPUS48_FAST_REMOVAL_ISO,
  opus48FastDeprecationText,
} from "@/lib/shared/fast-mode";

/**
 * CC 2.1.316 — "Deprecated fast mode for Opus 4.8 as of October 30, 2026; it
 * will be removed on November 30, 2026…Migrate to Opus 5.5 to keep the
 * speedup". The engine only emits its notice from its own `/fast` command;
 * Claudius's picker raises the same text itself. `now` is always injected.
 */
const BEFORE = Date.parse("2026-10-31T12:00:00Z");
const TEXT = "Opus 4.8 fast mode is deprecated and will be removed on Nov 30";

describe("opus48FastDeprecationText", () => {
  test("engine key and removal date", () => {
    expect(OPUS48_FAST_DEPRECATION_KEY).toBe("opus48-fast-mode-deprecation");
    expect(OPUS48_FAST_REMOVAL_ISO).toBe("2026-11-30");
  });

  test.each([
    "claude-opus-4-8",
    "claude-opus-4-8[1m]",
    "claude-opus-4.8",
    "us.anthropic.claude-opus-4-8-v1:0",
    "claude-opus-4-8@20260101",
  ])("%s → the engine's text", (model) => {
    expect(opus48FastDeprecationText(model, BEFORE)).toBe(TEXT);
  });

  test.each(["claude-opus-5-5", "claude-opus-4-7", "claude-sonnet-4-8", "opus", "opus[1m]", "", null, undefined])(
    "%s → null",
    (model) => {
      expect(opus48FastDeprecationText(model, BEFORE)).toBeNull();
    },
  );

  test("null at and after the removal instant", () => {
    const removal = Date.parse("2026-11-30T00:00:00Z");
    expect(opus48FastDeprecationText("claude-opus-4-8", removal - 1)).toBe(TEXT);
    expect(opus48FastDeprecationText("claude-opus-4-8", removal)).toBeNull();
    expect(opus48FastDeprecationText("claude-opus-4-8", removal + 86_400_000)).toBeNull();
  });
});
