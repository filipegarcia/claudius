import { describe, expect, test } from "vitest";
import {
  edgeAutoScrollStep,
  outOfViewIds,
  scrollPosToReveal,
  wheelToHorizontalDelta,
} from "@/components/chat/SessionTabs";
import { parseTabPlacement } from "@/lib/client/useTabPlacement";

/**
 * Geometry behind the scrollable session-tab strip (IntelliJ "scroll tabs"
 * mode) and its top / left / right placement. All helpers are axis-agnostic:
 * "start/size/scrollPos" are X/width/scrollLeft for the top strip and
 * Y/height/scrollTop for the vertical column.
 */

describe("scrollPosToReveal", () => {
  // Viewport 300px wide, content 1000px → maxScroll 700.
  const VIEW = 300;
  const MAX = 700;

  test("already fully visible → unchanged (nearest semantics)", () => {
    expect(scrollPosToReveal(150, 100, 100, VIEW, MAX)).toBe(100);
  });

  test("hidden off the start → align its start (minus margin)", () => {
    expect(scrollPosToReveal(50, 100, 200, VIEW, MAX)).toBe(50);
    expect(scrollPosToReveal(50, 100, 200, VIEW, MAX, 20)).toBe(30);
  });

  test("hidden off the end → align its end (plus margin)", () => {
    // Tab spans 500..600; viewport at 100 shows 100..400.
    expect(scrollPosToReveal(500, 100, 100, VIEW, MAX)).toBe(300);
    expect(scrollPosToReveal(500, 100, 100, VIEW, MAX, 20)).toBe(320);
  });

  test("visible but under the edge fade → nudged clear of it", () => {
    // Tab spans 380..400, flush with the viewport end at 400.
    expect(scrollPosToReveal(380, 20, 100, VIEW, MAX, 20)).toBe(120);
  });

  test("clamps to [0, maxScroll]", () => {
    expect(scrollPosToReveal(0, 100, 50, VIEW, MAX, 20)).toBe(0);
    expect(scrollPosToReveal(900, 100, 0, VIEW, MAX, 20)).toBe(MAX);
    // No overflow at all → always 0.
    expect(scrollPosToReveal(10, 50, 0, VIEW, 0, 20)).toBe(0);
  });

  test("item bigger than the viewport → show its start", () => {
    expect(scrollPosToReveal(200, 400, 0, VIEW, MAX)).toBe(200);
    expect(scrollPosToReveal(200, 400, 0, VIEW, MAX, 20)).toBe(200);
  });

  test("fits, but not with both margins → centred so it's fully visible", () => {
    // 280px tab in a 300px viewport with 20px margins (280 + 40 > 300).
    expect(scrollPosToReveal(500, 280, 100, VIEW, MAX, 20)).toBe(490);
    // Already fully visible → left alone.
    expect(scrollPosToReveal(110, 280, 100, VIEW, MAX, 20)).toBe(100);
  });
});

describe("outOfViewIds", () => {
  const items = [
    { id: "a", start: 0, size: 100 },
    { id: "b", start: 100, size: 100 },
    { id: "c", start: 200, size: 100 },
    { id: "d", start: 300, size: 100 },
  ];

  test("lists tabs not fully inside the viewport", () => {
    // Viewport 150..350 → only c (200..300) is fully visible.
    expect(outOfViewIds(items, 150, 200)).toEqual(["a", "b", "d"]);
  });

  test("everything fits → nothing hidden", () => {
    expect(outOfViewIds(items, 0, 400)).toEqual([]);
  });

  test("1px tolerance for sub-pixel rounding at the edges", () => {
    // Viewport 0..299.5 — d starts at 300 so it's out, c ends at 300 which
    // is within the tolerance.
    expect(outOfViewIds(items, 0, 299.5)).toEqual(["d"]);
  });
});

describe("wheelToHorizontalDelta", () => {
  const base = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false };

  test("vertical wheel (pixels) → horizontal delta", () => {
    expect(wheelToHorizontalDelta({ ...base, deltaY: 120 }, 500)).toBe(120);
    expect(wheelToHorizontalDelta({ ...base, deltaY: -40 }, 500)).toBe(-40);
  });

  test("line / page delta modes are scaled to px", () => {
    expect(wheelToHorizontalDelta({ ...base, deltaY: 3, deltaMode: 1 }, 500)).toBe(48);
    expect(wheelToHorizontalDelta({ ...base, deltaY: 1, deltaMode: 2 }, 500)).toBe(500);
  });

  test("horizontal-dominant gestures are left to the browser", () => {
    expect(wheelToHorizontalDelta({ ...base, deltaX: 30, deltaY: 10 }, 500)).toBeNull();
    expect(wheelToHorizontalDelta({ ...base, deltaX: 10, deltaY: 10 }, 500)).toBeNull();
  });

  test("ctrl+wheel (pinch zoom) and no-op events are ignored", () => {
    expect(wheelToHorizontalDelta({ ...base, deltaY: 50, ctrlKey: true }, 500)).toBeNull();
    expect(wheelToHorizontalDelta(base, 500)).toBeNull();
  });
});

describe("edgeAutoScrollStep", () => {
  // Strip spans 100..500 on screen, default 32px zone.
  test("comfortably inside → no scroll", () => {
    expect(edgeAutoScrollStep(300, 100, 500)).toBe(0);
    expect(edgeAutoScrollStep(132, 100, 500)).toBe(0);
    expect(edgeAutoScrollStep(468, 100, 500)).toBe(0);
  });

  test("near the start → scroll backwards, faster when deeper", () => {
    const shallow = edgeAutoScrollStep(125, 100, 500);
    const deep = edgeAutoScrollStep(102, 100, 500);
    expect(shallow).toBeLessThan(0);
    expect(deep).toBeLessThan(shallow);
  });

  test("near the end → scroll forwards", () => {
    expect(edgeAutoScrollStep(490, 100, 500)).toBeGreaterThan(0);
  });

  test("past the edge → capped at max", () => {
    expect(edgeAutoScrollStep(-500, 100, 500)).toBe(-18);
    expect(edgeAutoScrollStep(2000, 100, 500)).toBe(18);
  });
});

describe("parseTabPlacement", () => {
  test("accepts the known placements", () => {
    expect(parseTabPlacement("top")).toBe("top");
    expect(parseTabPlacement("left")).toBe("left");
    expect(parseTabPlacement("right")).toBe("right");
  });

  test("anything else falls back to top", () => {
    expect(parseTabPlacement(null)).toBe("top");
    expect(parseTabPlacement("bottom")).toBe("top");
    expect(parseTabPlacement(1)).toBe("top");
  });
});
