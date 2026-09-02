import { test, expect, type Page } from "../helpers/test";

/**
 * Regression test for the chat auto-scroll "I get pushed up randomly" bug in
 * `components/chat/MessageList.tsx`.
 *
 * Reported behavior: "I'm reading a chat message, the model sends another
 * message, and I get pushed up" — i.e. the reader has scrolled UP into history
 * and a newly-arriving assistant message yanks the viewport back to the bottom,
 * tearing them off the message they were reading.
 *
 * Root cause (commit 2abe5a5 "always-pin MessageList scroll via
 * ResizeObserver"): the refactor dropped the near-bottom gate the old
 * auto-scroll had (`if (isNearBottomRef.current)`). The ResizeObserver pin then
 * snapped to the bottom on EVERY height change — including a new message
 * arriving while the user was deliberately scrolled up. The fix restores the
 * gate: the pin only follows the bottom when the reader is already there.
 *
 * We drive a real bound session over the dev-broadcast bus (no Anthropic key):
 *   1. a user prompt + a long assistant reply that overflows the viewport →
 *      the view auto-pins to the bottom.
 *   2. scroll to the TOP (the reader is now in history) and confirm the
 *      "Jump to latest" affordance appears (proves isNearBottom went false).
 *   3. the model sends ANOTHER assistant message at the tail.
 *
 * Correct behavior: the viewport stays where the reader left it (near the top).
 * The bug snaps it to the bottom.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/** Mirrors `NEAR_BOTTOM_PX` in components/chat/MessageList.tsx. */
const NEAR_BOTTOM_PX = 80;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function pushAssistant(
  page: Page,
  sessionId: string,
  text: string,
  uuid: string,
  /** Explicit event timestamp; drives `createdAt` and therefore sort order. */
  at?: number,
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        ...(at !== undefined ? { at } : {}),
        message: {
          type: "assistant",
          uuid,
          parent_tool_use_id: null,
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        },
      },
    },
  });
  expect(res.ok(), `dev-broadcast assistant should succeed for ${sessionId}`).toBeTruthy();
}

async function pushUser(
  page: Page,
  sessionId: string,
  text: string,
  uuid: string,
  /** Explicit event timestamp; drives `createdAt` and therefore sort order. */
  at?: number,
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        ...(at !== undefined ? { at } : {}),
        message: { type: "user", uuid, message: { content: [{ type: "text", text }] } },
      },
    },
  });
  expect(res.ok(), `dev-broadcast user should succeed for ${sessionId}`).toBeTruthy();
}

function longReplyText(): string {
  const paragraph =
    "This is a long paragraph of assistant reply text designed to fill the chat viewport. ".repeat(
      8,
    );
  return Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}. ${paragraph}`).join("\n\n");
}

/** Resolve the MessageList scroll container and return its scroll geometry. */
async function scrollMetrics(
  page: Page,
  anchorUuid: string,
): Promise<{ scrollTop: number; distFromBottom: number; scrollHeight: number } | null> {
  return page.evaluate((uuid) => {
    const el = document.querySelector<HTMLElement>(`[data-message-uuid="${uuid}"]`);
    let scroller: HTMLElement | null = el?.parentElement ?? null;
    while (scroller && scroller !== document.body) {
      const style = window.getComputedStyle(scroller);
      if (style.overflowY === "auto" || style.overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return null;
    return {
      scrollTop: scroller.scrollTop,
      distFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
  }, anchorUuid);
}

/** Scroll the MessageList container to the very top, as a user would. */
async function scrollToTop(page: Page, anchorUuid: string): Promise<void> {
  await page.evaluate((uuid) => {
    const el = document.querySelector<HTMLElement>(`[data-message-uuid="${uuid}"]`);
    let scroller: HTMLElement | null = el?.parentElement ?? null;
    while (scroller && scroller !== document.body) {
      const style = window.getComputedStyle(scroller);
      if (style.overflowY === "auto" || style.overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    scroller?.scrollTo({ top: 0 });
  }, anchorUuid);
}

test.describe("chat scroll pinning", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
  });

  test("a reader scrolled up into history is NOT yanked to the bottom when the model sends another message", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const id = await waitForBoundSession(page);

    await pushUser(page, id, "What is the meaning of life?", "user-bug2");
    await pushAssistant(page, id, longReplyText(), "asst-1");

    await expect(page.locator('[data-message-uuid="asst-1"]')).toBeVisible({ timeout: 15_000 });

    // The reply must overflow the viewport, else the test proves nothing.
    await expect
      .poll(async () => (await scrollMetrics(page, "asst-1"))?.scrollHeight ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(1500);

    // The reader scrolls up into history. The "Jump to latest" affordance
    // appearing confirms the client registered that we left the bottom
    // (isNearBottom went false) — the precondition for the bug.
    await scrollToTop(page, "asst-1");
    await expect(page.getByTestId("jump-to-latest")).toBeVisible({ timeout: 10_000 });

    const before = await scrollMetrics(page, "asst-1");
    expect(before).not.toBeNull();
    expect(before!.distFromBottom).toBeGreaterThan(300);

    // The model sends ANOTHER message. On the buggy always-pin code this snaps
    // the viewport to the bottom; the fix leaves the reader where they were.
    await pushAssistant(page, id, "A second assistant message arrives mid-read.", "asst-2");
    await expect(page.locator('[data-message-uuid="asst-2"]')).toBeAttached({ timeout: 15_000 });

    // Give any (buggy) pin a chance to fire before we assert the reader stayed.
    await expect(page.getByTestId("jump-to-latest")).toBeVisible({ timeout: 5_000 });
    const after = await scrollMetrics(page, "asst-1");
    expect(after).not.toBeNull();
    expect(
      after!.distFromBottom,
      `reader was yanked toward the bottom: distFromBottom ${before!.distFromBottom} → ${after!.distFromBottom}`,
    ).toBeGreaterThan(300);
  });

  /**
   * The CONVERSE of the test above, and the direction that was never covered.
   *
   * The two behaviors are in tension and the fix has swung between them twice
   * (2abe5a5 → edabbb6 → 134639e), each swing shipping green because only one
   * direction had a test. A reader sitting AT the bottom must keep following
   * new content; a reader who scrolled UP must be left alone. Both specs have
   * to pass simultaneously or the pin logic is wrong again.
   *
   * The failure mode this catches: `pin()` writes `scrollTop = scrollHeight`
   * from a ResizeObserver callback, but the resulting scroll event is not
   * dispatched until the NEXT frame — by which time another streaming chunk
   * has been committed and `scrollHeight` has grown. `onScroll` then reads a
   * grown height against the pinned scrollTop, computes distFromBottom > 80,
   * and concludes the reader scrolled up. That permanently disarms the pin
   * (`isNearBottomRef`), so the view stops following the bottom and the user
   * has to scroll down by hand — repeatedly, for the rest of the turn.
   *
   * Several messages are pushed back-to-back on purpose: one tall append is
   * enough in principle, but a burst reproduces the interleaving of commits
   * and scroll dispatches that makes the stale read likely.
   */
  test("a reader sitting at the bottom keeps following new messages", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const id = await waitForBoundSession(page);

    await pushUser(page, id, "Walk me through it.", "user-follow");
    await pushAssistant(page, id, longReplyText(), "follow-1");

    await expect(page.locator('[data-message-uuid="follow-1"]')).toBeVisible({
      timeout: 15_000,
    });

    // Precondition: the content overflows and we are pinned at the bottom.
    await expect
      .poll(async () => (await scrollMetrics(page, "follow-1"))?.scrollHeight ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(1500);
    await expect
      .poll(async () => (await scrollMetrics(page, "follow-1"))?.distFromBottom ?? 9999, {
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(NEAR_BOTTOM_PX);

    // The reader does NOT touch the scroll wheel. Messages keep arriving.
    //
    // NOTE: this spec does NOT reproduce the user-reported "I get left behind
    // mid-stream" bug — it passes on unmodified code. It was written to close
    // the coverage gap that let the pin logic oscillate (2abe5a5 → edabbb6 →
    // 134639e) with CI green each time, because only the scrolled-up-reader
    // direction was ever asserted. Its job is to fail if a future fix for the
    // follow-the-bottom direction breaks it back the other way.
    //
    // Why it doesn't reproduce: dev-broadcast pushes land close enough
    // together that React batches them into one or two commits, so the
    // container grows in one step and the geometry `onScroll` reads is never
    // stale. Instrumenting the real container during this burst recorded only
    // 2 scroll events, both near-bottom. Reproducing the real bug needs
    // incremental `stream_event` deltas spread across many frames.
    const burst: Array<Promise<void>> = [];
    for (let i = 2; i <= 12; i++) {
      burst.push(
        pushAssistant(
          page,
          id,
          Array.from(
            { length: 6 },
            (_, k) => `Follow-up message ${i}, line ${k + 1}. ${"Filler text to add height. ".repeat(6)}`,
          ).join("\n\n"),
          `follow-${i}`,
        ),
      );
    }
    await Promise.all(burst);
    await expect(page.locator('[data-message-uuid="follow-12"]')).toBeAttached({
      timeout: 15_000,
    });

    // The viewport must still be following the tail. Poll so a late reflow or
    // a trailing pin gets its chance before we call it a failure.
    await expect
      .poll(async () => (await scrollMetrics(page, "follow-1"))?.distFromBottom ?? 9999, {
        timeout: 10_000,
        message:
          "view stopped following the bottom while the reader sat still — the pin gate was disarmed by its own scroll echo",
      })
      .toBeLessThanOrEqual(NEAR_BOTTOM_PX);

    // ...and the client must agree it is at the bottom, so the reader is not
    // told to "Jump to latest" while already looking at the latest.
    await expect(page.getByTestId("jump-to-latest")).toBeHidden();
  });

  /**
   * Regression test for "when a new message arrives I randomly get scrolled
   * UP, and it's worse on long conversations".
   *
   * `MessageList` treats any change of `messages[0].uuid` as a load-older
   * prepend and runs a scroll-position restore. But the head also changes
   * during ordinary streaming: `resyncFromDisk` re-broadcasts JSONL records
   * mid-turn carrying their ORIGINAL timestamp, and `sortMessagesByChronology`
   * sorts those to the front. Task-recovery and snapshot-fallback inserts
   * prepend too. The restore then fired for a reader sitting at the bottom,
   * landed above it, and stamped `lastPrependAtRef` — which suppressed the pin
   * that would have corrected it. Measured before the fix: the viewport moved
   * up 196px and sat 261px off the bottom until the next message re-pinned it.
   *
   * A front-sorting record is broadcast here with an explicit historical `at`,
   * which is precisely the shape resyncFromDisk produces.
   */
  test("a record that sorts to the front does not move a reader who is at the bottom", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto("/");
    const id = await waitForBoundSession(page);

    // A long transcript with explicit, ordered timestamps.
    // Size matters here. The defect displaces the viewport by ONE growth step,
    // so a short transcript hides it under the 80px near-bottom tolerance.
    // At 25 turns of this height the pre-fix displacement measured ~196px,
    // leaving the reader 261px off the bottom.
    const base = 1_800_000_000_000;
    for (let i = 0; i < 25; i++) {
      await pushUser(page, id, `Question ${i}?`, `q-${i}`, base + i * 1000);
      await pushAssistant(
        page,
        id,
        Array.from(
          { length: 4 },
          (_, k) => `Answer ${i} line ${k}. ${"body ".repeat(30)}`,
        ).join("\n\n"),
        `ans-${i}`,
        base + i * 1000 + 1,
      );
    }
    await expect(page.locator('[data-message-uuid="ans-24"]')).toBeAttached({
      timeout: 20_000,
    });

    // Precondition: overflowing, and parked at the bottom.
    await expect
      .poll(async () => (await scrollMetrics(page, "ans-24"))?.distFromBottom ?? 9999, {
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(NEAR_BOTTOM_PX);

    // A record from the past arrives and sorts ahead of everything on screen.
    await pushAssistant(
      page,
      id,
      "An older record replayed from disk mid-turn.",
      "ghost-old",
      base - 500_000,
    );
    await expect(page.locator('[data-message-uuid="ghost-old"]')).toBeAttached({
      timeout: 15_000,
    });

    // The reader never touched the scroll wheel, so they must still be at the
    // bottom. Before the fix this sat ~261px adrift.
    await expect
      .poll(async () => (await scrollMetrics(page, "ans-24"))?.distFromBottom ?? 9999, {
        timeout: 10_000,
        message:
          "a front-sorting record scrolled the reader up: the prepend restore ran for someone who was already at the bottom",
      })
      .toBeLessThanOrEqual(NEAR_BOTTOM_PX);
    await expect(page.getByTestId("jump-to-latest")).toBeHidden();
  });
});
