import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Regression test for the "pin last user message at top of chat" behavior in
 * `components/chat/MessageList.tsx`.
 *
 * The last turn's user message is wrapped in a `<div>` with
 * `position: sticky; top: 0`. When the assistant's reply is long enough that
 * the user has to scroll to read it, the user message stays pinned at the top
 * of the scroll viewport so the question is always visible.
 *
 * We drive the SSE stream directly (same pattern as `cost-tile.spec.ts`) —
 * no real API call required. The script delivers one user message and one
 * very long assistant message. After the initial auto-scroll-to-bottom lands,
 * we assert that the user message's bounding box top is flush with the top
 * of the scroll container (within a small tolerance for padding/border).
 *
 * Without `position: sticky`, the user message would have scrolled far above
 * the viewport and its `top - scrollContainerTop` delta would be a large
 * negative number; the visibility assertion would also fail.
 */

const FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
const USER_UUID = "user-1";
const ASSISTANT_UUID = "asst-1";
const USER_TEXT = "What is the meaning of life, the universe, and everything?";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
    },
  },
];

function userEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      message: { content: [{ type: "text", text }] },
    },
  };
}

function assistantEvent(uuid: string, text: string): SdkEvent {
  return {
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
  };
}

/**
 * Build a wall of text long enough that the assistant reply overflows the
 * 800px viewport several times over — guarantees the scroll container is
 * actually scrollable so the sticky-pin behavior has something to do.
 */
function longReplyText(): string {
  const paragraph =
    "This is a long paragraph of assistant reply text designed to fill the chat viewport. ".repeat(
      8,
    );
  return Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}. ${paragraph}`).join("\n\n");
}

test.describe("sticky last-user-message", () => {
  test("keeps the most recent user message visible at the top of the chat while scrolled through a long reply", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      userEvent(USER_UUID, USER_TEXT),
      assistantEvent(ASSISTANT_UUID, longReplyText()),
      { type: "replay_done", hasMoreAbove: false },
    ]);

    await page.goto("/");

    const userMsg = page.locator(`[data-message-uuid="${USER_UUID}"]`);
    const assistantMsg = page.locator(`[data-message-uuid="${ASSISTANT_UUID}"]`);

    // Both messages must mount before we measure anything.
    await expect(userMsg).toBeVisible({ timeout: 15_000 });
    await expect(assistantMsg).toBeVisible({ timeout: 15_000 });

    // Drive the scroll to the bottom. The MessageList one-shot already
    // auto-scrolls to bottom on `replay_done`, but doing it explicitly here
    // makes the test resilient to that effect being reordered or removed.
    const scrollMetrics = await page.evaluate((uuid) => {
      const el = document.querySelector<HTMLElement>(
        `[data-message-uuid="${uuid}"]`,
      );
      // Walk up to find the nearest scrollable ancestor (the MessageList
      // scroll container). We can't hardcode a selector — it's a Tailwind
      // utility soup — so use computed style.
      let scroller: HTMLElement | null = el?.parentElement ?? null;
      while (scroller && scroller !== document.body) {
        const style = window.getComputedStyle(scroller);
        if (style.overflowY === "auto" || style.overflowY === "scroll") break;
        scroller = scroller.parentElement;
      }
      if (!scroller) return null;
      scroller.scrollTop = scroller.scrollHeight;
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollerTop: scroller.getBoundingClientRect().top,
      };
    }, ASSISTANT_UUID);

    expect(scrollMetrics).not.toBeNull();
    // Sanity: the reply must overflow the viewport, otherwise the test
    // proves nothing.
    expect(scrollMetrics!.scrollHeight).toBeGreaterThan(
      scrollMetrics!.clientHeight + 100,
    );
    expect(scrollMetrics!.scrollTop).toBeGreaterThan(100);

    // The sticky user message must still be visible at the top of the chat
    // viewport. Without `position: sticky`, after the scroll-to-bottom above,
    // the user message would be well outside the viewport.
    await expect(userMsg).toBeInViewport();

    // Stronger assertion: the user message's bounding box top sits at the
    // top of the scroll container (within a small tolerance for the sticky
    // wrapper's own padding/border). This is what visually distinguishes
    // "pinned" from "happens to be near the top because the reply is short".
    const delta = await userMsg.evaluate((el, scrollerTop) => {
      return Math.abs(el.getBoundingClientRect().top - scrollerTop);
    }, scrollMetrics!.scrollerTop);
    // py-2 (8px) + border (1px) → allow up to ~16px of slack.
    expect(delta).toBeLessThan(16);
  });
});
