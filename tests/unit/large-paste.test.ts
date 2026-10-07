import { describe, expect, test } from "vitest";
import {
  applyEditToRanges,
  diffEdit,
  inlinePastesInText,
  isLargePaste,
  LARGE_PASTE_MIN_CHARS,
  pastedSpans,
  type PasteRange,
} from "@/lib/shared/large-paste";

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

/**
 * CC 2.1.292 — "pasted text reaching Claude as typed text when several pastes
 * overlapped in one prompt". Drive the helpers the way the composer does:
 * every text change is one diffEdit applied to the recorded ranges.
 */
describe("paste ranges (CC 2.1.292)", () => {
  function change(ranges: PasteRange[], prev: string, next: string, caret?: number): PasteRange[] {
    return applyEditToRanges(ranges, diffEdit(prev, next, caret));
  }

  test("a paste dropped inside an earlier paste keeps both as one pasted block", () => {
    const A = "line a1\nline a2\nline a3\nline a4";
    const B = "line b1\nline b2\nline b3\nline b4";
    let text = "intro: " + A;
    let ranges: PasteRange[] = [{ start: 7, end: 7 + A.length }];
    const at = 7 + A.indexOf("line a3");
    const next = text.slice(0, at) + B + text.slice(at);
    // The composer knows a paste's exact edit (its selection), not a diff.
    ranges = applyEditToRanges(ranges, { at, removed: 0, inserted: B.length });
    ranges.push({ start: at, end: at + B.length }); // B's own range
    text = next;
    const spans = pastedSpans(ranges, text);
    expect(spans).toEqual([text.slice(7)]);
    // The old string matching lost A entirely (it is no longer contiguous).
    expect(inlinePastesInText([A, B], text)).toEqual([B]);
  });

  test("typing before a paste shifts it; typing after leaves it", () => {
    const text = "PASTED";
    let ranges: PasteRange[] = [{ start: 0, end: 6 }];
    ranges = change(ranges, text, "hi PASTED");
    expect(pastedSpans(ranges, "hi PASTED")).toEqual(["PASTED"]);
    ranges = change(ranges, "hi PASTED", "hi PASTED!");
    expect(pastedSpans(ranges, "hi PASTED!")).toEqual(["PASTED"]);
  });

  test("typed text inside a paste is not marked as pasted", () => {
    let ranges: PasteRange[] = [{ start: 0, end: 8 }];
    ranges = change(ranges, "ABCDEFGH", "ABCDxEFGH");
    expect(pastedSpans(ranges, "ABCDxEFGH")).toEqual(["ABCD", "EFGH"]);
  });

  test("deleting inside a paste keeps the rest as one span", () => {
    let ranges: PasteRange[] = [{ start: 0, end: 8 }];
    ranges = change(ranges, "ABCDEFGH", "ABCEFGH");
    expect(pastedSpans(ranges, "ABCEFGH")).toEqual(["ABCEFGH"]);
  });

  test("the caret settles an insert inside a run of repeats", () => {
    // "xPASTED" → type "P" at 1: prefix matching alone says index 2.
    expect(diffEdit("xPASTED", "xPPASTED")).toEqual({ at: 2, removed: 0, inserted: 1 });
    expect(diffEdit("xPASTED", "xPPASTED", 2)).toEqual({ at: 1, removed: 0, inserted: 1 });
    const ranges = change([{ start: 1, end: 7 }], "xPASTED", "xPPASTED", 2);
    expect(pastedSpans(ranges, "xPPASTED")).toEqual(["PASTED"]);
    // A caret outside the ambiguous run is ignored.
    expect(diffEdit("xPASTED", "xPPASTED", 7)).toEqual({ at: 2, removed: 0, inserted: 1 });
  });

  test("deleting the whole paste drops it; a replace of part of it keeps the rest", () => {
    expect(pastedSpans(change([{ start: 3, end: 9 }], "hi PASTED", "hi "), "hi ")).toEqual([]);
    const ranges = change([{ start: 0, end: 6 }], "PASTED", "PAzzED");
    expect(pastedSpans(ranges, "PAzzED")).toEqual(["PA", "ED"]);
  });
});
