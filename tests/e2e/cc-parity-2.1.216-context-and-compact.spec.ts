/**
 * CC 2.1.216 parity — two related `/context` / `/compact` UX fixes from the
 * changelog:
 *
 *   "`/context` now shows an explicit warning when the conversation exceeds
 *   the context window, and a failed `/compact` displays as an error."
 *
 * Claudius already had a context-usage banner (ContextWarningBanner.tsx,
 * gated by a user-configurable threshold via useContextWarning.ts) and a
 * `/compact` slash command — but neither distinguished "exceeded" from
 * "approaching full", and a failed compaction silently reverted the
 * "Compacting…" indicator with no visible error. This release extends both:
 *
 *   - `shouldShowContextWarning` (lib/client/useContextWarning.ts) now always
 *     returns true once usage is genuinely over 100%, regardless of the
 *     user's threshold pref (even "Never"), and ContextWarningBanner.tsx
 *     renders distinct "Context window exceeded" copy for that state.
 *   - `use-session.ts` tracks a pending `/compact` via the `slash_invoked`
 *     breadcrumb; if the very next `result` event has a non-success subtype
 *     with no intervening `compact_boundary`, it pushes a "Compaction
 *     failed: …" entry onto `session.errors` (rendered via the existing
 *     `data-testid="session-error"` banner — no new visual language needed).
 *
 * This spec drives the SSE stream directly with `page.route` (same harness
 * as `cost-tile.spec.ts`) — no real SDK/agent needed for either assertion.
 *
 * Screenshot targets:
 *   docs/cc-parity/2.1.216/context-window-exceeded.png
 *   docs/cc-parity/2.1.216/compact-failed.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.216");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "66666666-7777-8888-9999-000000000000";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Mirrors cost-tile.spec.ts's mockChatBackend, plus a stubbed /context route. */
async function mockChatBackend(
  page: Page,
  opts: { events: SdkEvent[]; contextSummary?: { totalTokens: number; maxTokens: number; percentage: number } },
): Promise<void> {
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
      body: sseBody(opts.events),
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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        opts.contextSummary ?? { totalTokens: 1000, maxTokens: 200_000, percentage: 0.5 },
      ),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-1", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.describe("Context-exceeded warning + failed /compact error (CC 2.1.216 parity)", () => {
  test("banner shows 'Context window exceeded' once usage is over 100%", async ({ page }) => {
    await mockChatBackend(page, {
      events: PRELUDE,
      contextSummary: { totalTokens: 284_000, maxTokens: 200_000, percentage: 142 },
    });

    await page.goto("/");

    await expect(page.getByText("Context window exceeded")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("context-exceeded-note")).toContainText(
      "over the model's context limit",
    );

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "context-window-exceeded.png"),
      fullPage: false,
    });
  });

  test("boundary: 99.5% (rounds to 100%) shows the regular 'full' banner, not 'exceeded'", async ({
    page,
  }) => {
    // Regression guard: the banner must derive `exceeded` from the RAW
    // percentage, not `Math.round(percentage)` — rounding first would flip
    // a genuine 99.5% into a displayed "100%" and wrongly call it exceeded.
    await mockChatBackend(page, {
      events: PRELUDE,
      contextSummary: { totalTokens: 199_000, maxTokens: 200_000, percentage: 99.5 },
    });

    await page.goto("/");

    await expect(page.getByText("Context window is 100% full")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Context window exceeded")).toHaveCount(0);
  });

  test("a /compact turn that ends without a compact_boundary surfaces 'Compaction failed'", async ({
    page,
  }) => {
    await mockChatBackend(page, {
      events: [
        ...PRELUDE,
        {
          type: "sdk",
          message: {
            type: "system",
            subtype: "slash_invoked",
            uuid: "sys-2",
            command: "/compact",
            args: "",
          },
        },
        {
          type: "sdk",
          message: {
            type: "result",
            uuid: "result-1",
            subtype: "error_during_execution",
            errors: ["compaction summarization failed"],
            num_turns: 1,
            duration_ms: 500,
            duration_api_ms: 500,
          },
        },
      ],
    });

    await page.goto("/");

    const errorBanner = page.getByTestId("session-error");
    await expect(errorBanner).toBeVisible({ timeout: 15_000 });
    await expect(errorBanner).toHaveText("Compaction failed: compaction summarization failed");

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "compact-failed.png"), fullPage: false });
  });

  test("a /compact that ends in error_max_budget_usd shows only the budget banner, not a duplicate", async ({
    page,
  }) => {
    // Regression guard: error_max_budget_usd already gets its own clearer
    // "Session stopped: max budget reached" banner a few lines above the
    // compact-failed check — that check must not ALSO fire "Compaction
    // failed: error_max_budget_usd" for the same result.
    await mockChatBackend(page, {
      events: [
        ...PRELUDE,
        {
          type: "sdk",
          message: {
            type: "system",
            subtype: "slash_invoked",
            uuid: "sys-3",
            command: "/compact",
            args: "",
          },
        },
        {
          type: "sdk",
          message: {
            type: "result",
            uuid: "result-2",
            subtype: "error_max_budget_usd",
            total_cost_usd: 5,
            num_turns: 1,
            duration_ms: 500,
            duration_api_ms: 500,
          },
        },
      ],
    });

    await page.goto("/");

    await expect(page.getByText("Session stopped: max budget reached")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-error")).toHaveCount(1);
    await expect(page.getByText(/Compaction failed/)).toHaveCount(0);
  });
});
