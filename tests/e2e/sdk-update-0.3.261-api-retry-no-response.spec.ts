/**
 * SDK 0.3.261 — `SDKAPIRetryMessage.no_response`.
 *
 * Upstream added an optional `no_response` object to the `api_retry` system
 * message, present only when the API sent no response headers within the
 * first-byte timeout (a hung connection, distinct from an HTTP error
 * status). Claudius already forwards raw SDK system messages verbatim over
 * SSE (see `tests/e2e/cc-parity-2.1.198-api-retry.spec.ts`), so the field
 * reaches the browser either way — but until this release nothing read it,
 * so a `no_response` retry rendered the same generic "Retrying the
 * request…" copy as any other first-attempt retry, or a reason-named line
 * on later attempts that wrongly implied an HTTP error occurred.
 *
 * `describeApiRetry` (lib/client/api-retry.ts) now special-cases
 * `noResponse` with its own copy, wired through `use-session.ts`. This spec
 * drives the same mocked-SSE harness as the 2.1.198 spec to get the app
 * into a mid-turn retry state and screenshots the resulting spinner tip in
 * context.
 *
 * Screenshot: docs/sdk-updates/0.3.261/api-retry-no-response.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.261");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000030261";

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
  { type: "turn_status", status: "running" },
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

function apiRetryNoResponseEvent(opts: {
  uuid: string;
  attempt: number;
  maxRetries: number;
  waitedMs: number;
  retryWaitMs: number;
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
      retry_delay_ms: opts.retryWaitMs,
      error_status: null,
      error: "unknown",
      no_response: { waited_ms: opts.waitedMs, retry_wait_ms: opts.retryWaitMs },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDK 0.3.261 — api_retry no_response", () => {
  test("a no_response retry shows dedicated copy instead of the generic/reason lines", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      apiRetryNoResponseEvent({
        uuid: "retry-no-response-1",
        attempt: 1,
        maxRetries: 1,
        waitedMs: 30_000,
        retryWaitMs: 5_000,
      }),
    ]);
    await page.goto("/");

    const workingRow = page.getByText("Claude is working…");
    await expect(workingRow).toBeVisible({ timeout: 15_000 });

    const tip = page.getByTestId("spinner-tip");
    await expect(tip).toBeVisible({ timeout: 15_000 });
    await expect(tip).toHaveText("Anthropic's API didn't respond in time — retrying…");
    // Distinct from both the generic first-attempt copy and the
    // reason-named copy a plain HTTP-error retry would show.
    await expect(tip).not.toHaveText("Retrying the request…");
    await expect(page.getByTestId("spinner-tip-status-link")).toHaveCount(0);

    await tip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "api-retry-no-response.png"),
      fullPage: false,
    });
  });
});
