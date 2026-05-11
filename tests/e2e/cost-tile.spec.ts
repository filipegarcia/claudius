import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Regression test for the cost tile in the right-rail Activity panel.
 *
 * Bug fixed (2026-05-11): `$` tile stayed at `$0.00` even after thousands of
 * tokens had been streamed. Two independent causes:
 *   1. Cost was only updated at the SDK `result` event — mid-turn, while
 *      token tiles ticked up, the cost stayed frozen.
 *   2. The `result` update was gated on `subtype === "success"`, so turns
 *      that ended with `error_max_turns` or interrupts left cost at 0
 *      forever.
 *
 * This spec drives the SSE stream directly with `page.route` + chunked
 * `text/event-stream` body — no real API call needed. The same pattern is a
 * starting point for a wider mocked-backend e2e harness (see
 * `mockChatBackend` below): you give it a script of SSE events, the page
 * runs against it, and assertions hit only deterministic UI state.
 */

const FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

type SdkEvent = Record<string, unknown>;

/**
 * Build the SSE response body. Each event is one `data: <json>\n\n` frame —
 * EventSource parses on the `\n\n` delimiter. All events are flushed up
 * front; the browser receives the whole stream as soon as the route fulfils,
 * which is fine for replay-style fixtures where the script is known in
 * advance. For mid-test interaction (push more events after asserting), use
 * `page.evaluate` to dispatch a synthetic `MessageEvent` against the live
 * `EventSource` instead.
 */
function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

type MockScript = {
  /** Events delivered on the SSE stream. Pre-canned, sent all at once. */
  events: SdkEvent[];
};

/**
 * Mount a minimal mock backend for the chat page:
 *   - POST /api/sessions      → returns FAKE_SESSION_ID
 *   - GET  /api/sessions/<id>/stream → SSE stream of the scripted events
 *   - GET  /api/sessions/open-tabs   → empty (don't resume any persisted tab)
 *   - GET  /api/sessions/<id>/pending-prompts → empty
 *   - GET  /api/limits             → no caps configured
 *
 * Other endpoints fall through to the dev server. The chat page tolerates
 * 404s on most non-critical endpoints (notifications, claude.md, plugins,
 * etc.); we only stub the ones the cost path actually depends on.
 */
async function mockChatBackend(page: Page, script: MockScript): Promise<void> {
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
      body: sseBody(script.events),
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

/** SDK assistant message wrapper, as seen on the SSE stream. */
function assistantEvent(opts: {
  uuid: string;
  model?: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: opts.uuid,
      parent_tool_use_id: null,
      message: {
        model: opts.model ?? "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        usage: opts.usage,
      },
    },
  };
}

function resultEvent(opts: {
  uuid?: string;
  subtype?: string;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
}): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "result",
      // uuid is what use-session dedupes on so reconnects don't double-apply
      // cost. In the real SDK this is always present (UUID); we default to a
      // deterministic value here for test stability.
      uuid: opts.uuid ?? `result-${Math.random().toString(36).slice(2)}`,
      subtype: opts.subtype ?? "success",
      total_cost_usd: opts.totalCostUsd,
      num_turns: opts.numTurns ?? 1,
      duration_ms: opts.durationMs ?? 1234,
      duration_api_ms: opts.durationMs ?? 1234,
    },
  };
}

/** Frames the chat page sends through `applyEvent` before useful state lands. */
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
  { type: "replay_done", hasMoreAbove: false },
];

test.describe("cost tile", () => {
  test("shows the SDK's authoritative cost after the result event", async ({ page }) => {
    await mockChatBackend(page, {
      events: [
        ...PRELUDE,
        assistantEvent({
          uuid: "a1",
          usage: { input_tokens: 800, output_tokens: 200 },
        }),
        // Authoritative cost: $1.42 (≥ $1 so `fmtUsd` uses .toFixed(2) and
        // we get a stable 5-char render — values under $1 render as
        // "$0.420" which is fine but less obvious in test expectations).
        resultEvent({ totalCostUsd: 1.42, numTurns: 1 }),
      ],
    });

    await page.goto("/");

    // Wait for the rail to mount.
    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("token-tile-cost-value")).toHaveText("$1.42");

    // Sanity: tokens rendered too — verifies the assistant event flowed.
    // `fmtTokens` renders <1000 as raw, ≥1000 as "1.0k" / "1.2M" — keep this
    // input under 1k for a stable plain-integer string.
    await expect(page.getByTestId("token-tile-in-value")).toHaveText("800");
    await expect(page.getByTestId("token-tile-out-value")).toHaveText("200");
  });

  test("estimates cost mid-turn before the result event lands (regression: $0.00 forever)", async ({
    page,
  }) => {
    // No result event — only assistant deltas. With the old code, cost
    // would stay at $0.00 forever. With the fix, the mid-turn estimate
    // makes the tile non-zero.
    await mockChatBackend(page, {
      events: [
        ...PRELUDE,
        // 500k input + 500k output Sonnet tokens ≈ $9 estimate. Lower
        // bound is enough to distinguish from $0.00 / NaN.
        assistantEvent({
          uuid: "a1",
          usage: { input_tokens: 500_000, output_tokens: 500_000 },
        }),
      ],
    });

    await page.goto("/");

    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });
    // Don't pin the exact value (pricing may drift) — just assert it's no
    // longer $0.00 and is a well-formed dollar string.
    await expect(page.getByTestId("token-tile-cost-value")).not.toHaveText("$0.00");
    await expect(page.getByTestId("token-tile-cost-value")).toHaveText(/^\$\d/);
  });

  test("applies cost on non-success result subtypes (regression: success-only gate)", async ({
    page,
  }) => {
    await mockChatBackend(page, {
      events: [
        ...PRELUDE,
        assistantEvent({
          uuid: "a1",
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
        // The SDK can emit a result with `error_max_turns` etc. — those
        // turns still cost money. The pre-fix code gated cost updates on
        // `subtype === "success"`, so non-success turns left $0.00.
        resultEvent({ subtype: "error_max_turns", totalCostUsd: 1.23 }),
      ],
    });

    await page.goto("/");

    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("token-tile-cost-value")).toHaveText("$1.23");
  });
});
