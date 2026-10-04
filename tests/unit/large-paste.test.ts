import { describe, expect, test } from "vitest";
import { inlinePastesInText, isLargePaste, LARGE_PASTE_MIN_CHARS } from "@/lib/shared/large-paste";

/**
 * CC 2.1.280 — a paste is "large" (and gets marked as inline_pastes) when it
 * exceeds 800 chars OR has more than 2 line breaks.
 */
describe("isLargePaste (CC 2.1.280 — D6)", () => {
  test("long text (>800 chars) qualifies", () => {
    expect(isLargePaste("a".repeat(LARGE_PASTE_MIN_CHARS + 1))).toBe(true);
    expect(isLargePaste("a".repeat(LARGE_PASTE_MIN_CHARS))).toBe(false);
  });

  test("more than two line breaks qualifies", () => {
    expect(isLargePaste("one\ntwo\nthree\nfour")).toBe(true); // 3 newlines
    expect(isLargePaste("one\ntwo\nthree")).toBe(false); // 2 newlines
  });

  test("short, few-line text does not qualify", () => {
    expect(isLargePaste("just a line")).toBe(false);
    expect(isLargePaste("line1\nline2")).toBe(false);
    expect(isLargePaste("")).toBe(false);
  });
});

describe("inlinePastesInText (CC 2.1.280 — D6)", () => {
  test("matches a trailing-newline paste against the trimmed, sent text", () => {
    const seg = "a huge log\nwith lines\n"; // pasted with a trailing newline
    const wire = "see:\na huge log\nwith lines"; // composer trimmed the tail
    expect(inlinePastesInText([seg], wire)).toEqual(["a huge log\nwith lines"]);
  });

  test("drops a segment the user deleted before sending", () => {
    expect(inlinePastesInText(["gone now"], "something else entirely")).toEqual([]);
  });

  test("keeps only the segments still present", () => {
    const wire = "kept paste text and more";
    expect(inlinePastesInText(["kept paste text", "removed"], wire)).toEqual(["kept paste text"]);
  });
});
