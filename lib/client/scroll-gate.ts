/**
 * The decision rule behind the chat's "follow the bottom" pin.
 *
 * `components/chat/MessageList.tsx` keeps a boolean gate (`isNearBottomRef`):
 * while it is armed, a ResizeObserver pins the viewport to the bottom on every
 * height change; once it is dropped, the pin stands down so a reader who
 * scrolled up into history is left alone.
 *
 * Deciding when to drop that gate is the whole problem, because a programmatic
 * pin and a user's wheel gesture produce byte-identical `scroll` events. The
 * original code guessed from timing — "ignore scroll events for 250ms after we
 * pinned" — and that proxy cannot satisfy both directions at once:
 *
 *   • Suppress the whole window → a genuine mid-stream scroll-up is swallowed
 *     and the reader is yanked back to the bottom.
 *   • Suppress only `near === true` → a stale-geometry `near === false` event
 *     permanently disarms the pin, and the reader stops following new content
 *     ("I get scrolled up when new messages arrive and have to scroll down").
 *
 * The pin logic oscillated between those two failure modes across three
 * commits, each shipping green because only one direction had a test.
 *
 * Direction is the signal the time window was approximating. Every
 * user-initiated scroll-up — wheel, trackpad, touch drag, scrollbar drag,
 * PageUp/Home, find-in-page — DECREASES scrollTop. Our own pin, and content
 * growing or reflowing beneath a stationary viewport, never do: scrollTop is
 * unchanged or larger. So the gate drops only when the viewport actually moved
 * up, and no timing guess is needed.
 *
 * Kept as a pure function so the rule is unit-testable without a browser; the
 * e2e specs in tests/e2e/chat-scroll-pin.spec.ts cover the integration.
 */

/** Distance from the bottom, in px, still considered "at the bottom". */
export const NEAR_BOTTOM_PX = 80;

/**
 * Minimum decrease in scrollTop that counts as a deliberate scroll-up. Absorbs
 * sub-pixel jitter (fractional DPR and browser zoom make scrollTop a float)
 * without swallowing a real gesture, which moves tens of pixels at minimum.
 */
export const SCROLL_UP_EPS_PX = 1;

export type ScrollGateInput = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** scrollTop at the previous scroll event, or the value the pin last wrote. */
  prevScrollTop: number;
};

/**
 * The next value for the pin gate, or `null` to leave it unchanged.
 *
 *   true  — at the bottom: arm the pin and follow new content.
 *   false — the viewport genuinely moved up: stand the pin down.
 *   null  — far from the bottom, but the viewport did not move up, so the gap
 *           opened because the CONTENT grew underneath a stationary reader.
 *           Ignore it and let the pin catch up.
 */
export function nextPinGate(input: ScrollGateInput): boolean | null {
  const { scrollTop, scrollHeight, clientHeight, prevScrollTop } = input;
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  // At the bottom: always re-arm. This doubles as the self-heal — however the
  // gate got dropped, returning to the bottom resumes following.
  if (distFromBottom <= NEAR_BOTTOM_PX) return true;
  // Far from the bottom but stationary (or moving down): not a scroll-up.
  if (scrollTop >= prevScrollTop - SCROLL_UP_EPS_PX) return null;
  return false;
}
