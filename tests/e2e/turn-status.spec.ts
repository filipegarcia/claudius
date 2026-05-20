import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Regression test for the "session looks Idle even though the agent is mid-turn"
 * bug (see `lib/server/session.ts`'s `broadcastTurnStatusIfChanged` and
 * `applyEvent`'s `turn_status` handler in `lib/client/use-session.ts`).
 *
 * Before the fix: opening a session URL while the server was still processing
 * a long-running tool call (e.g. a multi-minute `Bash`) painted the StatusLine
 * as "Idle". The buffer replay carried streaming chunks that set `pending=true`,
 * but `replay_done` unconditionally cleared it — and without further events
 * arriving for a while, the dot stayed green and the text stayed "Idle".
 *
 * The fix adds a `turn_status` SSE event. The server broadcasts it on every
 * `turnInFlight`/pending-prompt transition AND re-emits it to every new
 * subscriber right after `replay_done`. This spec drives the SSE stream with
 * `page.route` and asserts the StatusLine + active-tab status dot follow the
 * server's authoritative truth in each scenario.
 */

const FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * Mount the minimum set of stubs the chat page reads on first load — enough
 * for the SSE-driven state machine to settle into a known mode. Other
 * endpoints fall through (the page tolerates 404s on non-critical ones).
 */
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

/** Frames the chat page expects before useful state lands. */
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

test.describe("turn_status", () => {
  test("idle attach: StatusLine settles on 'Idle' when the server reports idle", async ({
    page,
  }) => {
    // Server has nothing in flight — the canonical "fresh page, no turn" path.
    // After `replay_done` and `turn_status=idle` the dot stays green / text says Idle.
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "idle" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await expect(statusText).toHaveText("Idle");
    await expect(page.getByTestId("status-line-dot")).toHaveAttribute(
      "data-status",
      "idle",
    );
  });

  test("mid-turn attach: 'turn_status=running' after replay_done flips the StatusLine to 'Working'", async ({
    page,
  }) => {
    // The bug scenario. Replay carries an assistant chunk (which optimistically
    // sets pending=true during the replay loop), `replay_done` would normally
    // clear pending=false, and then the server's authoritative
    // `turn_status=running` reasserts the truth. Pre-fix, only the first two
    // steps happened and the UI stayed "Idle".
    await mockChatBackend(page, [
      ...PRELUDE,
      assistantEvent("a1", "partial reply mid-turn..."),
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await expect(statusText).toHaveText("Working");
    await expect(page.getByTestId("status-line-dot")).toHaveAttribute(
      "data-status",
      "working",
    );
  });

  test("running → idle transition: a later 'turn_status=idle' settles the StatusLine", async ({
    page,
  }) => {
    // Verifies the live broadcast path (not just the subscribe-time re-emit):
    // the server flips turnInFlight false at result-event time and broadcasts
    // turn_status=idle. The client should follow.
    await mockChatBackend(page, [
      ...PRELUDE,
      assistantEvent("a1", "still working..."),
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
      { type: "turn_status", status: "idle" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    // The final state is what matters — both events are flushed at once so the
    // intermediate "Working" frame may not be observable depending on render
    // timing. Assert on the terminal state.
    await expect(statusText).toHaveText("Idle");
    await expect(page.getByTestId("status-line-dot")).toHaveAttribute(
      "data-status",
      "idle",
    );
  });
});
