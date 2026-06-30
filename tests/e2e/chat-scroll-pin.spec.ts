import { test, expect, type Page } from "../helpers/test";

/**
 * Regression test for the chat auto-scroll "won't stay pinned to bottom /
 * random scroll-ups" bug in `components/chat/MessageList.tsx`.
 *
 * Root cause (introduced by 2abe5a5 "always-pin MessageList scroll via
 * ResizeObserver"): the load-older detector keys purely on
 * `messages[0].uuid` changing. But the chronologically-sorted message array
 * legitimately changes its head for NON-load-older reasons — a reconnect
 * replay landing out of order, or the `session_snapshot` fallback prepending
 * the server's latest prompt. When that happens the prepend branch runs
 *
 *     el.scrollTop = prevScrollTopRef.current + delta
 *
 * using refs captured at the previous layout-effect pass — i.e. BEFORE the
 * ResizeObserver pinned the view to the bottom — so it restores a stale,
 * non-bottom scroll position: a visible jump UP, with the auto-pin also
 * suspended for 350ms.
 *
 * We reproduce it deterministically by driving a real bound session over the
 * dev-broadcast bus (no Anthropic key needed):
 *   1. a user prompt + a long assistant reply that overflows the viewport →
 *      the view auto-pins to the bottom.
 *   2. inject one assistant message with a very OLD `at` so the client's
 *      chronological sort places it at the FRONT — changing `messages[0].uuid`
 *      exactly the way a reconnect reorder / snapshot prepend does.
 *
 * Correct behavior: the view stays at the bottom (the new content is older
 * history, scrolled off the top — it must not yank the reader away from the
 * freshest message). The bug strands the view far from the bottom.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

/** Push an assistant text message with an explicit observed-at timestamp. */
async function pushAssistant(
  page: Page,
  sessionId: string,
  text: string,
  uuid: string,
  at: number,
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        at,
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

/** Push a user prompt with an explicit observed-at timestamp. */
async function pushUser(
  page: Page,
  sessionId: string,
  text: string,
  uuid: string,
  at: number,
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        at,
        message: {
          type: "user",
          uuid,
          message: { content: [{ type: "text", text }] },
        },
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

/**
 * Resolve the MessageList scroll container (Tailwind soup — can't hardcode a
 * selector) and return its scroll geometry. `distFromBottom` is the metric
 * the test asserts on.
 */
async function scrollMetrics(
  page: Page,
  anchorUuid: string,
): Promise<{ distFromBottom: number; scrollHeight: number; clientHeight: number } | null> {
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
      distFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  }, anchorUuid);
}

test.describe("chat scroll pinning", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
  });

  test("stays pinned to bottom when an out-of-order message changes the head (no random scroll-up)", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const id = await waitForBoundSession(page);

    const base = Date.now();
    await pushUser(page, id, "What is the meaning of life?", "user-bug2", base);
    await pushAssistant(page, id, longReplyText(), "asst-bug2", base + 1);

    const replyMsg = page.locator('[data-message-uuid="asst-bug2"]');
    await expect(replyMsg).toBeVisible({ timeout: 15_000 });

    // The reply must overflow the viewport, else the test proves nothing, and
    // the activation anchor should have landed us at the bottom.
    await expect
      .poll(async () => (await scrollMetrics(page, "asst-bug2"))?.scrollHeight ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(1000);
    await expect
      .poll(async () => (await scrollMetrics(page, "asst-bug2"))?.distFromBottom ?? 9999, {
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(80);

    // Head-churn: an assistant message timestamped in 1970 sorts to the FRONT
    // of the chronological array — the same head change a reconnect reorder /
    // snapshot prepend produces. This must NOT pull the view off the bottom.
    await pushAssistant(page, id, "ancient out-of-order context", "asst-ancient", 1000);
    await expect(page.locator('[data-message-uuid="asst-ancient"]')).toBeAttached({
      timeout: 15_000,
    });

    // The freshest reply must still be the pinned, in-view content.
    const after = await scrollMetrics(page, "asst-bug2");
    expect(after).not.toBeNull();
    expect(
      after!.distFromBottom,
      `view was stranded ${after!.distFromBottom}px from the bottom after a head-changing inject`,
    ).toBeLessThanOrEqual(80);
  });
});
