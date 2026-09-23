import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Regression test for "I left the tab and when I got back the answer was gone."
 *
 * The transcript is the only surface in the app fed exclusively by SSE —
 * status dots, cost, the session list and suggested follow-ups are all
 * HTTP-polled. So when the EventSource died permanently (readyState CLOSED,
 * which the browser reaches when a retry is answered with a non-2xx) the chat
 * froze at that instant while every panel around it kept updating. The
 * reported case lost five minutes and ~250 transcript records that were
 * sitting safely on disk and in the server's buffer the whole time.
 *
 * Pre-fix, `es.onerror` only cleared `pending` on CLOSED, and `bindToSession`
 * was reachable only from boot and `switchSession` (which early-returns on
 * the current id) — so nothing short of a reload could resurrect the feed.
 *
 * This spec drives the three states through `page.route`:
 *   1. a healthy stream paints a transcript,
 *   2. a 404 on reconnect kills it — the "Reconnecting" badge appears and the
 *      STALE transcript stays on screen (wiping early would leave an empty
 *      chat indistinguishable from lost history),
 *   3. the retry lands and the transcript rebuilds with what was missed.
 */

const FAKE_SESSION_ID = "99999999-8888-7777-6666-555555555555";

/** Text only ever served by the FIRST stream — what the tab had before the death. */
const BEFORE_TEXT = "Checking how that page renders timestamps.";
/** Text only ever served AFTER recovery — the answer the frozen tab never saw. */
const AFTER_TEXT = "Everything on that page is stored in UTC.";

type SdkEvent = Record<string, unknown>;

/**
 * `retry:` is a standard SSE directive setting the browser's reconnection
 * delay. Chromium defaults to 3s, which would stretch this spec past its
 * timeout once the recovery backoff (1s, 2s, 4s …) is layered on top. The
 * production server doesn't send it — this is purely to keep the test quick
 * and its timing margins wide.
 */
function sseBody(events: SdkEvent[]): string {
  return ["retry: 500\n\n", ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`)].join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-1", model: "claude-sonnet-4-6" },
  },
];

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

const TAIL: SdkEvent[] = [
  { type: "replay_done", hasMoreAbove: false },
  { type: "turn_status", status: "idle" },
];

/**
 * Stub the endpoints the chat page reads on first load, and serve the stream
 * from a per-connection script.
 *
 * `streamAttempts` counts every GET the browser makes on the stream route —
 * including the ones `EventSource` issues by itself. A finite SSE body ends
 * the connection, so the browser always reconnects on its own after the first
 * script entry; the 404 entry is what pushes it into the terminal CLOSED
 * state that only our own recovery can come back from.
 */
async function mockChatBackend(
  page: Page,
  script: Array<{ status: 404 } | { status: 200; events: SdkEvent[] }>,
): Promise<{ attempts: () => number }> {
  let streamAttempts = 0;

  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    // Past the end of the script, hold the last entry — otherwise a stray
    // reconnect at the end of the test would 404 and flip the badge back on
    // while we're asserting it's gone.
    const step = script[Math.min(streamAttempts, script.length - 1)];
    streamAttempts++;
    if (step.status === 404) {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "session not found" });
    }
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(step.events),
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

  return { attempts: () => streamAttempts };
}

test.describe("SSE stream recovery", () => {
  test("a dead stream reconnects and rebuilds the transcript it missed", async ({ page }) => {
    const { attempts } = await mockChatBackend(page, [
      // 1. Healthy attach.
      { status: 200, events: [...PRELUDE, assistantEvent("a1", BEFORE_TEXT), ...TAIL] },
      // 2. The browser's own reconnect is refused — this is what drives the
      //    EventSource to CLOSED, after which it never retries again. The
      //    next two 404s are our own backing-off recovery attempts failing:
      //    they keep the outage alive long enough to outlast the badge
      //    debounce (a shorter outage is deliberately not worth a warning)
      //    and they exercise more than one turn of the backoff.
      { status: 404 },
      { status: 404 },
      { status: 404 },
      // 3. Our recovery re-binds and the server replays the full transcript,
      //    including everything the frozen tab never saw.
      {
        status: 200,
        events: [
          ...PRELUDE,
          assistantEvent("a1", BEFORE_TEXT),
          assistantEvent("a2", AFTER_TEXT),
          ...TAIL,
        ],
      },
    ]);

    await page.goto("/");

    // 1. The tab has a transcript.
    await expect(page.getByText(BEFORE_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(AFTER_TEXT)).toHaveCount(0);

    // 2. The stream dies and stays dead past the debounce. The badge is the
    //    whole point: without it a frozen transcript is indistinguishable
    //    from a session with nothing to say.
    const badge = page.getByTestId("status-line-stream");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    // …and the stale transcript is still there. Clearing it before a
    // successful reconnect would show an empty chat, which reads as data loss.
    await expect(page.getByText(BEFORE_TEXT)).toBeVisible();

    // 3. Recovery lands: the missed answer appears and the badge clears.
    await expect(page.getByText(AFTER_TEXT)).toBeVisible({ timeout: 20_000 });
    await expect(badge).toHaveCount(0);
    await expect(page.getByText(BEFORE_TEXT)).toBeVisible();

    // The recovery reconnects are ours, not browser retries: the browser
    // stops trying once it has seen the 404, so every GET past the second can
    // only have come from our own timer.
    expect(attempts()).toBeGreaterThanOrEqual(5);
  });
});
