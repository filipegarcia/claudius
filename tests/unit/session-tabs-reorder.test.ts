import { describe, expect, test } from "vitest";
import {
  computeReorderOverIdx,
  reorderArray,
  tabShiftForReorder,
} from "@/components/chat/SessionTabs";

/**
 * Locks in the geometry of session-tab drag-to-reorder.
 *
 * Three pure helpers back the interaction:
 *
 *   • `reorderArray`         — splice-remove + splice-insert, with bounds
 *                              checks and reference-stable no-ops so the
 *                              parent's persistence effect doesn't fire on
 *                              same-spot drops.
 *   • `computeReorderOverIdx` — maps (pointer X, tab rects) to a
 *                              splice-compatible target index. The ±1
 *                              compensation for fromIdx < target is the
 *                              part most likely to regress on a refactor.
 *   • `tabShiftForReorder`   — sign + magnitude of the visual translate
 *                              applied to non-dragged tabs while the drag
 *                              is in flight. Wrong signs here = tabs
 *                              sliding the wrong way as the user drags.
 *
 * The e2e spec drives the real pointer events; this test fences the math
 * with fast feedback so a refactor that flips one of these branches fails
 * loudly without spinning up a browser.
 */

describe("reorderArray", () => {
  test("moves an item from the middle to a later slot", () => {
    // fromIdx=1 (B), toIdx=2 → splice semantics: remove B, then insert at
    // index 2 of the post-remove array → B lands between C and D.
    expect(reorderArray(["A", "B", "C", "D"], 1, 2)).toEqual(["A", "C", "B", "D"]);
  });

  test("moves an item from the middle to an earlier slot", () => {
    expect(reorderArray(["A", "B", "C", "D"], 2, 1)).toEqual(["A", "C", "B", "D"]);
  });

  test("drags the first tab to the end", () => {
    expect(reorderArray(["A", "B", "C", "D"], 0, 3)).toEqual(["B", "C", "D", "A"]);
  });

  test("drags the last tab to the front", () => {
    expect(reorderArray(["A", "B", "C", "D"], 3, 0)).toEqual(["D", "A", "B", "C"]);
  });

  test("returns the input by reference when fromIdx === toIdx", () => {
    // Identity check matters: the parent useState setter bails on
    // referential equality, which is what keeps the open-tabs PUT effect
    // from firing on a no-op drop.
    const input = ["A", "B", "C"];
    expect(reorderArray(input, 1, 1)).toBe(input);
  });

  test("returns the input by reference when an index is out of range", () => {
    const input = ["A", "B", "C"];
    expect(reorderArray(input, -1, 1)).toBe(input);
    expect(reorderArray(input, 0, 99)).toBe(input);
    expect(reorderArray(input, 5, 0)).toBe(input);
  });

  test("returns a NEW array reference for a real move (forces re-render)", () => {
    const input = ["A", "B", "C"];
    const out = reorderArray(input, 0, 2);
    expect(out).not.toBe(input);
    expect(out).toEqual(["B", "C", "A"]);
    // Input must not be mutated — splice mutates in place, so the helper
    // has to slice first. Lock that in.
    expect(input).toEqual(["A", "B", "C"]);
  });
});

describe("tabShiftForReorder", () => {
  // Helper to flag the direction without us caring about the exact px value.
  const sign = (n: number) => Math.sign(n);

  test("the dragged tab itself never shifts", () => {
    expect(tabShiftForReorder(2, 2, 0, 100)).toBe(0);
    expect(tabShiftForReorder(2, 2, 5, 100)).toBe(0);
  });

  test("tabs between fromIdx and overIdx (drag right) slide LEFT to fill the gap", () => {
    // fromIdx=1 (B), overIdx=3 (drop past D). Tabs at idx 2 (C) and 3 (D)
    // must shift left by draggedWidth so the gap visually moves rightward.
    expect(sign(tabShiftForReorder(2, 1, 3, 100))).toBe(-1);
    expect(sign(tabShiftForReorder(3, 1, 3, 100))).toBe(-1);
    expect(tabShiftForReorder(2, 1, 3, 100)).toBe(-100);
  });

  test("tabs between overIdx and fromIdx (drag left) slide RIGHT", () => {
    // fromIdx=3 (D), overIdx=0 (drop before A). Tabs at idx 0, 1, 2 must
    // shift right by draggedWidth.
    expect(sign(tabShiftForReorder(0, 3, 0, 100))).toBe(1);
    expect(sign(tabShiftForReorder(1, 3, 0, 100))).toBe(1);
    expect(sign(tabShiftForReorder(2, 3, 0, 100))).toBe(1);
    expect(tabShiftForReorder(1, 3, 0, 100)).toBe(100);
  });

  test("tabs outside the reorder range stay put", () => {
    // fromIdx=1, overIdx=2 — only the tab at idx 2 should shift; idx 0 and
    // anything past idx 2 are unaffected.
    expect(tabShiftForReorder(0, 1, 2, 100)).toBe(0);
    expect(tabShiftForReorder(3, 1, 2, 100)).toBe(0);
    expect(tabShiftForReorder(2, 1, 2, 100)).toBe(-100);
  });

  test("overIdx === fromIdx → no tabs shift (still in original slot)", () => {
    // The drop is at the dragged tab's home position — visually nothing
    // should move on either side.
    for (let i = 0; i < 5; i++) {
      expect(tabShiftForReorder(i, 2, 2, 100)).toBe(0);
    }
  });
});

describe("computeReorderOverIdx", () => {
  // Build a stable strip of rects: four tabs at x=0, 100, 200, 300 with
  // width 100. Centers fall at 50, 150, 250, 350.
  const rects = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
    { left: 300, width: 100 },
  ];

  test("drag B (fromIdx=1) past D's center → drop at end (idx 3)", () => {
    expect(computeReorderOverIdx(rects, 1, 9999)).toBe(rects.length - 1);
  });

  test("drag B (fromIdx=1) between C and D → splice-target 2 (yields [A,C,B,D])", () => {
    // Between C (center 250) and D (center 350) the pointer X is e.g. 320 —
    // first center past pointer is D at i=3. Since fromIdx(1) < i(3), the
    // helper returns i-1 = 2. Splice in `reorderArray` then inserts B at
    // index 2 of [A,C,D], yielding [A,C,B,D].
    expect(computeReorderOverIdx(rects, 1, 320)).toBe(2);
    // Confirm the round-trip lands the expected final order.
    expect(reorderArray(["A", "B", "C", "D"], 1, 2)).toEqual(["A", "C", "B", "D"]);
  });

  test("drag C (fromIdx=2) past A's center → splice-target 0", () => {
    // Pointer X = 10 (before A's center at 50). The first non-dragged tab
    // whose center is past the pointer is A at i=0. fromIdx(2) > i(0), so
    // result = i = 0.
    expect(computeReorderOverIdx(rects, 2, 10)).toBe(0);
    expect(reorderArray(["A", "B", "C", "D"], 2, 0)).toEqual(["C", "A", "B", "D"]);
  });

  test("drag B (fromIdx=1) just left of A's center → splice-target 0", () => {
    // From the LEFT side, fromIdx(1) > i(0) so result = i = 0.
    expect(computeReorderOverIdx(rects, 1, 10)).toBe(0);
    expect(reorderArray(["A", "B", "C", "D"], 1, 0)).toEqual(["B", "A", "C", "D"]);
  });

  test("skips the dragged tab when scanning rects (no off-by-one when fromIdx is in range)", () => {
    // Pointer inside B's natural slot (x=120). The dragged tab itself (B,
    // fromIdx=1) is skipped; the next center past 120 is C at i=2.
    // fromIdx(1) < i(2) → result = 1. Splice on [A,B,C,D]: remove B, then
    // insert at 1 → [A,B,C,D] (no-op for the array). The reorderTab caller
    // catches that via the fromIdx === toIdx guard. The IMPORTANT thing
    // here is that the helper does NOT return i-1 = 0 (which would yield
    // the wrong "drop before A" result while the user is hovering their
    // own slot).
    expect(computeReorderOverIdx(rects, 1, 120)).toBe(1);
  });

  test("treats null rects as hidden tabs and skips them", () => {
    // Tab at idx 2 is hidden (rect=null). Pointer X = 250 — past A and B
    // (centers 50 and 150), past the hidden slot, but before D (center
    // 350). The first non-null center past pointer is D at i=3.
    // fromIdx=0, so result = i-1 = 2.
    const sparse = [rects[0], rects[1], null, rects[3]];
    expect(computeReorderOverIdx(sparse, 0, 250)).toBe(2);
  });

  test("empty / single-tab strips return a sensible fallback", () => {
    // Single tab dragged "to itself" — splice math: result = rects.length-1
    // = 0 = fromIdx, which the caller's `fromIdx === toIdx` guard turns
    // into a no-op.
    expect(computeReorderOverIdx([rects[0]], 0, 50)).toBe(0);
    // Empty rects: the loop never runs, falls through to rects.length-1 =
    // -1. The caller's bounds check in reorderArray treats that as a
    // no-op, so the final outcome is "nothing happens" rather than a
    // crash. Document that here.
    expect(computeReorderOverIdx([], 0, 50)).toBe(-1);
    expect(reorderArray(["A"], 0, -1)).toEqual(["A"]);
  });
});
