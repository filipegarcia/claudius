/**
 * Claude Code 2.1.198 parity — "Improved API retry UX".
 *
 * Upstream: "the error reason is now shown after the second attempt, and a
 * status page link replaces the spinner tip when the API is overloaded."
 *
 * The SDK already emits `SDKAPIRetryMessage` (`system`/`api_retry`) whenever
 * a retryable API error is being retried with backoff — Claudius forwards
 * raw SDK system messages verbatim over SSE, so the message reaches the
 * browser, but nothing consumed it (see `lib/client/api-retry.ts` /
 * `describeApiRetry`, wired into `use-session.ts` + `SpinnerTip`).
 *
 * This spec mocks the SSE stream with a mid-turn `api_retry` message (no
 * assistant/result event follows, so the turn stays "in flight" — matching
 * the real scenario where the retry is still pending) and asserts:
 *   1. A first-attempt, non-overload retry shows a generic "Retrying…" line
 *      with no reason (the CLI's "not yet on the second attempt" case).
 *   2. A second-attempt retry names the reason and attempt count.
 *   3. An overload retry replaces the tip with a status-page link,
 *      regardless of attempt number.
 *
 * Screenshots:
 *   - docs/cc-parity/2.1.198/api-retry-overloaded.png
 *   - docs/cc-parity/2.1.198/api-retry-reason.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.198");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000021198";

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
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
  // Authoritative "the agent is mid-turn" signal — flips `pending` true so
  // the "Claude is working…" row (and its SpinnerTip) renders.
  { type: "turn_status", status: "running" },
  // A real (non-empty) transcript — MessageList shows the empty-state
  // SplashScreen instead of the turn view whenever `messages.length === 0`,
  // regardless of `pending`. One partial assistant chunk is enough to reach
  // the turn view, where a mid-turn retry (no result yet) plausibly happens
  // on a follow-up tool call.
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Let me check that for you…" }],
        usage: { input_tokens: 50, output_tokens: 8 },
      },
    },
  },
];

function apiRetryEvent(opts: {
  uuid: string;
  attempt: number;
  maxRetries: number;
  error: string;
  errorStatus: number | null;
}): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "system",
      subtype: "api_retry",
      uuid: opts.uuid,
      session_id: FAKE_SESSION_ID,
      attempt: opts.attempt,
      max_retries: opts.maxRetries,
      retry_delay_ms: 2000,
      error_status: opts.errorStatus,
      error: opts.error,
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.198 — API retry UX", () => {
  test("first-attempt retry shows a generic line with no reason", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      apiRetryEvent({
        uuid: "retry-1",
        attempt: 1,
        maxRetries: 5,
        error: "server_error",
        errorStatus: 500,
      }),
    ]);
    await page.goto("/");

    const workingRow = page.getByText("Claude is working…");
    await expect(workingRow).toBeVisible({ timeout: 15_000 });

    const tip = page.getByTestId("spinner-tip");
    await expect(tip).toHaveText("Retrying the request…");
    await expect(page.getByTestId("spinner-tip-status-link")).toHaveCount(0);
  });

  test("second-attempt retry names the reason and attempt count", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      apiRetryEvent({
        uuid: "retry-2",
        attempt: 2,
        maxRetries: 5,
        error: "rate_limit",
        errorStatus: 429,
      }),
    ]);
    await page.goto("/");

    const tip = page.getByTestId("spinner-tip");
    await expect(tip).toBeVisible({ timeout: 15_000 });
    await expect(tip).toContainText("Retrying after a rate limit (attempt 2/5)…");
    await expect(page.getByTestId("spinner-tip-status-link")).toHaveCount(0);

    await tip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "api-retry-reason.png"),
      fullPage: false,
    });
  });

  test("overload retry replaces the tip with a status-page link", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      apiRetryEvent({
        uuid: "retry-3",
        attempt: 1,
        maxRetries: 10,
        error: "overloaded",
        errorStatus: 529,
      }),
    ]);
    await page.goto("/");

    const tip = page.getByTestId("spinner-tip");
    await expect(tip).toBeVisible({ timeout: 15_000 });
    await expect(tip).toContainText("overloaded");

    const link = page.getByTestId("spinner-tip-status-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://status.anthropic.com");

    await tip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "api-retry-overloaded.png"),
      fullPage: false,
    });
  });
});
