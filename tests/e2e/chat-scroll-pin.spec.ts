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
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
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
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
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
});
