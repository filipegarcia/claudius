import { describe, expect, test } from "vitest";
import { ordinalFloorAfterRestore, stashClearedDraft } from "@/lib/client/cleared-draft";
import { applyEditToRanges, diffEdit, pastedSpans, type PasteRange } from "@/lib/shared/large-paste";

/**
 * CC 2.1.326 — "Fixed pasted text and images being dropped when ↑ recalls a
 * draft cleared with Esc Esc". The stash now carries the paste ranges, and the
 * restore lifts the image-ordinal counter past the restored images.
 */
describe("stashClearedDraft (CC 2.1.326)", () => {
  const paste = "line 1\nline 2\nline 3\nline 4";
  const text = `Review: ${paste}[Image #1] `;
  const ranges: PasteRange[] = [{ start: "Review: ".length, end: "Review: ".length + paste.length }];
  const images = [{ id: "a", ordinal: 1 }];

  test("a stashed draft's paste survives the round trip", () => {
    const stash = stashClearedDraft(text, images, ranges);
    expect(stash.text).toBe(text);
    expect(stash.images).toBe(images);
    expect(pastedSpans(stash.pasteRanges, stash.text)).toEqual([paste]);
  });

  test("without the stashed ranges, the restore reads as one typed insert", () => {
    // The pre-fix path: ranges were wiped by the clear and the layout effect
    // diffed "" → text, which records no paste at all.
    const lost = applyEditToRanges([], diffEdit("", text, text.length));
    expect(pastedSpans(lost, text)).toEqual([]);
  });

  test("the stash doesn't alias the live range array", () => {
    const live = ranges.map((r) => ({ ...r }));
    const stash = stashClearedDraft(text, images, live);
    live[0].start = 0;
    live.push({ start: 0, end: 1 });
    expect(stash.pasteRanges).toEqual(ranges);
  });
});

describe("ordinalFloorAfterRestore (CC 2.1.326)", () => {
  test("lifts a zeroed counter past every restored ordinal", () => {
    expect(ordinalFloorAfterRestore(0, [{ ordinal: 1 }, { ordinal: 3 }])).toBe(3);
  });
  test("never lowers the counter", () => {
    expect(ordinalFloorAfterRestore(5, [{ ordinal: 2 }])).toBe(5);
  });
  test("no images leaves the counter alone", () => {
    expect(ordinalFloorAfterRestore(0, [])).toBe(0);
  });
});
