import { describe, expect, test } from "vitest";
import {
  NEAR_BOTTOM_PX,
  SCROLL_UP_EPS_PX,
  nextPinGate,
} from "@/lib/client/scroll-gate";

/**
 * The chat pin gate. `null` means "leave the gate as it is".
 *
 * The two behaviors are in direct tension and the implementation has swung
 * between them three times (2abe5a5 → edabbb6 → 134639e), so both directions
 * are asserted here rather than only the one that was most recently broken.
 */

/** A 600px-tall viewport over `scrollHeight` px of content. */
function at(scrollTop: number, scrollHeight: number, prevScrollTop = scrollTop) {
  return { scrollTop, scrollHeight, clientHeight: 600, prevScrollTop };
}

describe("nextPinGate", () => {
  describe("arms at the bottom", () => {
    test("exactly at the bottom", () => {
      expect(nextPinGate(at(1400, 2000))).toBe(true);
    });

    test("within the near-bottom tolerance", () => {
      expect(nextPinGate(at(1400 - NEAR_BOTTOM_PX, 2000))).toBe(true);
    });

    test("re-arms even when the reader arrived by scrolling UP into the zone", () => {
      // Self-heal: however the gate was dropped, returning to the bottom
      // resumes following. Direction must not veto an at-bottom reading.
      expect(nextPinGate(at(1340, 2000, 1400))).toBe(true);
    });
  });

  describe("drops when the reader genuinely scrolls up", () => {
    test("a wheel gesture away from the bottom", () => {
      expect(nextPinGate(at(900, 2000, 1400))).toBe(false);
    });

    test("a jump to the very top", () => {
      expect(nextPinGate(at(0, 2000, 1400))).toBe(false);
    });

    test("a small but real scroll-up past the epsilon", () => {
      expect(nextPinGate(at(1000, 2000, 1000 + SCROLL_UP_EPS_PX + 1))).toBe(false);
    });
  });

  describe("ignores movement that came from the content, not the reader", () => {
    test("content grew beneath a stationary viewport", () => {
      // THE REPORTED BUG. pin() wrote scrollTop=1400 when scrollHeight was
      // 2000; a frame later another chunk committed and scrollHeight is 2400.
      // The echo of our own write now reads 400px from the bottom. The old
      // code called that a scroll-up and permanently disarmed the pin.
      expect(nextPinGate(at(1400, 2400, 1400))).toBeNull();
    });

    test("content grew a lot between the pin write and its echo", () => {
      expect(nextPinGate(at(1400, 5000, 1400))).toBeNull();
    });

    test("intermediate frames of a smooth scroll DOWN", () => {
      // jumpToBottom animates toward the bottom; every intermediate frame is
      // far from the bottom but moving down. These used to flicker the gate
      // (and the "Jump to latest" button) off and on mid-animation.
      expect(nextPinGate(at(800, 2000, 700))).toBeNull();
      expect(nextPinGate(at(1100, 2000, 800))).toBeNull();
    });

    test("sub-pixel jitter is not a scroll-up", () => {
      // Fractional DPR / browser zoom make scrollTop a float.
      expect(nextPinGate(at(999.6, 2000, 1000))).toBeNull();
    });
  });

  describe("a reader parked up in history is left alone", () => {
    test("stationary while messages stream in below", () => {
      // Gate is already false; every one of these must return null so nothing
      // re-arms the pin and yanks them down. This is the direction covered by
      // the older of the two e2e specs.
      expect(nextPinGate(at(200, 3000, 200))).toBeNull();
      expect(nextPinGate(at(200, 4000, 200))).toBeNull();
      expect(nextPinGate(at(200, 9000, 200))).toBeNull();
    });

    test("scrolling further up stays dropped", () => {
      expect(nextPinGate(at(100, 3000, 200))).toBe(false);
    });
  });

  describe("degenerate geometry", () => {
    test("content shorter than the viewport reads as at-bottom", () => {
      expect(nextPinGate(at(0, 300))).toBe(true);
    });

    test("empty transcript reads as at-bottom", () => {
      expect(nextPinGate(at(0, 0))).toBe(true);
    });
  });
});
