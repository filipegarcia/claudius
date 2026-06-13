import { describe, expect, test } from "vitest";
import {
  clampReorderTarget,
  normalizePinnedOrder,
  reorderArray,
} from "@/components/chat/SessionTabs";

/**
 * Locks in the two pure helpers behind tab pinning:
 *
 *   • `normalizePinnedOrder` — sorts pinned ids to the front while preserving
 *     relative order within each group, and returns the input by reference
 *     when already normalized (so the chat page's render-time "adjust state"
 *     pass converges in one step instead of looping).
 *   • `clampReorderTarget`   — keeps a drag-reorder drop inside the dragged
 *     tab's own group, so an unpinned tab can't be dragged into the pinned
 *     zone (and vice-versa).
 */

describe("normalizePinnedOrder", () => {
  test("moves a pinned id to the front", () => {
    expect(normalizePinnedOrder(["A", "B", "C", "D"], new Set(["C"]))).toEqual([
      "C",
      "A",
      "B",
      "D",
    ]);
  });

  test("preserves relative order within the pinned and unpinned groups", () => {
    expect(
      normalizePinnedOrder(["A", "B", "C", "D", "E"], new Set(["D", "B"])),
    ).toEqual(["B", "D", "A", "C", "E"]);
  });

  test("returns the input by reference when already normalized", () => {
    const input = ["B", "D", "A", "C"];
    // B and D pinned and already leading → no movement.
    expect(normalizePinnedOrder(input, new Set(["B", "D"]))).toBe(input);
  });

  test("empty pinned set is always a no-op (reference-stable)", () => {
    const input = ["A", "B", "C"];
    expect(normalizePinnedOrder(input, new Set())).toBe(input);
  });

  test("all pinned keeps the original order (reference-stable)", () => {
    const input = ["A", "B", "C"];
    expect(normalizePinnedOrder(input, new Set(["A", "B", "C"]))).toBe(input);
  });

  test("ignores pinned ids not present in the list", () => {
    expect(normalizePinnedOrder(["A", "B"], new Set(["Z", "B"]))).toEqual(["B", "A"]);
  });
});

describe("clampReorderTarget", () => {
  // Strip: [P0, P1 | U2, U3, U4] — pinnedCount = 2, length = 5.
  const PINNED = 2;
  const LEN = 5;

  test("an unpinned tab can move freely within the unpinned region", () => {
    expect(clampReorderTarget(3, 4, PINNED, LEN)).toBe(4);
    expect(clampReorderTarget(4, 2, PINNED, LEN)).toBe(2);
  });

  test("an unpinned tab dragged toward the pinned zone is clamped to the boundary", () => {
    // U3 dragged to index 0 → clamped to the first unpinned slot (2).
    expect(clampReorderTarget(3, 0, PINNED, LEN)).toBe(2);
  });

  test("a pinned tab can move within the pinned region", () => {
    expect(clampReorderTarget(0, 1, PINNED, LEN)).toBe(1);
    expect(clampReorderTarget(1, 0, PINNED, LEN)).toBe(0);
  });

  test("a pinned tab dragged into the unpinned zone is clamped to the last pinned slot", () => {
    expect(clampReorderTarget(0, 4, PINNED, LEN)).toBe(1);
  });

  test("single-tab group has no room → returns fromIdx (caller no-ops)", () => {
    // Only one pinned tab: it cannot move. clamp returns fromIdx so
    // reorderArray's fromIdx === toIdx guard makes it a no-op.
    expect(clampReorderTarget(0, 3, 1, LEN)).toBe(0);
    expect(reorderArray(["P", "A", "B", "C", "D"], 0, 0)).toEqual([
      "P",
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("round-trips with reorderArray staying within the unpinned group", () => {
    const tabs = ["P0", "P1", "U2", "U3", "U4"];
    const clamped = clampReorderTarget(2, 0, PINNED, LEN); // U2 dragged left
    expect(reorderArray(tabs, 2, clamped)).toEqual(["P0", "P1", "U2", "U3", "U4"]);
  });
});
