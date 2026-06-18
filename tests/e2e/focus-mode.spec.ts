import { test, expect, type Page, type Route } from "../helpers/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { UPDATE_SCREENSHOTS } from "./helpers/marketing-screenshot";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * Focus mode is a three-level, global toggle (off → focus → zen) that
 * progressively strips the chat surface down. This spec drives the REAL chat
 * page (not an isolated dev preview) against a mocked SSE backend so the
 * conversation renders deterministically — the same `page.route` + canned
 * `text/event-stream` pattern as `cost-tile.spec.ts`.
 *
 * It doubles as the marketing-screenshot producer for `focus-mode.png`
 * (written only when UPDATE_SCREENSHOTS=1 — see
 * tests/e2e/helpers/marketing-screenshot.ts).
 */

const FAKE_SESSION_ID = "f0c05f0c-0000-4000-8000-f0c05f0c0001";
const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A user-authored prompt as it appears on the SSE stream. */
function userEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
    },
  };
}

/** An assistant turn (text only — ultra-compact keeps just the final prose). */
function assistantEvent(uuid: string, text: string, outputTokens: number): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 1200, output_tokens: outputTokens },
      },
    },
  };
}

function resultEvent(uuid: string, totalCostUsd: number, numTurns: number): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "result",
      uuid,
      subtype: "success",
      total_cost_usd: totalCostUsd,
      num_turns: numTurns,
      duration_ms: 1234,
      duration_api_ms: 1234,
    },
  };
}

/**
 * A short, realistic two-turn coding session. In ultra-compact (which focus
 * mode forces) each turn collapses to the prompt + the final assistant answer,
 * so this reads cleanly with no tool-call noise.
 */
const CONVERSATION: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-1", model: "claude-sonnet-4-6" },
  },
  { type: "session_title", title: "Migrate checkout to the new payments API" },
  { type: "replay_done", hasMoreAbove: false },

  userEvent("u1", "Refactor the checkout flow to use our new payments API."),
  assistantEvent(
    "a1",
    "Done. I moved `lib/server/checkout.ts` onto the new `PaymentsClient`: the three direct " +
      "Stripe calls collapsed into a single `client.charge()`, and the webhook handler now verifies " +
      "signatures with `PAYMENTS_WEBHOOK_SECRET`. All 14 checkout tests pass.",
    320,
  ),
  resultEvent("r1", 0.21, 1),

  userEvent("u2", "Nice. Did you handle declined cards?"),
  assistantEvent(
    "a2",
    "Yes — a declined charge now throws `CardDeclinedError` carrying the issuer's decline code, and " +
      "the checkout UI shows a retry prompt instead of a generic failure. I also added a regression " +
      "test covering the `insufficient_funds` path.",
    280,
  ),
  resultEvent("r2", 0.39, 2),
];

/**
 * Minimal mocked backend for the chat page — mirrors `cost-tile.spec.ts`.
 * Only the session endpoints the focus-mode view touches are stubbed; the
 * rest fall through to the dev server (the page tolerates their 404s).
 */
async function mockChatBackend(page: Page): Promise<void> {
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
      body: sseBody(CONVERSATION),
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

test.describe("focus mode", () => {
  test.beforeEach(async ({ page }) => {
    await activateClaudiusWorkspace(page);
    await mockChatBackend(page);
  });

  test("cycles off → focus → zen, hiding more chrome at each level", async ({ page }) => {
    await page.goto("/");

    // The conversation rendered from the mocked stream.
    await expect(page.getByText("All 14 checkout tests pass.")).toBeVisible({ timeout: 20_000 });

    const toggle = page.getByTestId("focus-toggle");
    const leftNav = page.locator('[data-pane-name="left-nav"]');
    const rightRail = page.locator('[data-pane-name="right-rail"]');
    const workspaceRail = page.locator('[data-pane-name="workspace-switcher"]');
    const sessionHeader = page.getByTestId("session-header");

    // ── off: everything visible ──────────────────────────────────────────
    await expect(toggle).toHaveAttribute("data-focus-level", "off");
    await expect(leftNav).toBeVisible();
    await expect(rightRail).toBeVisible();
    await expect(workspaceRail).toBeVisible();
    await expect(sessionHeader).toBeVisible();

    // ── focus: nav rail + activity panel gone, workspace rail stays ───────
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-focus-level", "focus");
    await expect(leftNav).toHaveCount(0);
    await expect(rightRail).toHaveCount(0);
    await expect(workspaceRail).toBeVisible();
    await expect(sessionHeader).toBeVisible();

    // ── zen: workspace rail + session header + every other header control
    //         gone; only the toggle remains, relabelled "Zen Mode" ─────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-focus-level", "zen");
    await expect(workspaceRail).toHaveCount(0);
    await expect(sessionHeader).toHaveCount(0);
    await expect(page.getByTestId("verbose-selector")).toHaveCount(0);
    await expect(toggle).toContainText("Zen Mode");

    // Marketing screenshot: the distraction-free zen state — just tabs + the
    // conversation. Captured here (not at the focus level) because it's the
    // cleanest, least-busy view of the feature.
    await page.waitForTimeout(300);
    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({ path: resolve(SHOTS_DIR, "focus-mode.png"), fullPage: false });
    }

    // ── back to off ──────────────────────────────────────────────────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-focus-level", "off");
    await expect(leftNav).toBeVisible();
    await expect(rightRail).toBeVisible();
  });
});
