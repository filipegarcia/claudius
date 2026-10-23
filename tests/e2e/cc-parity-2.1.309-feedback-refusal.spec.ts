/**
 * CC 2.1.309 parity — "Fixed feedback saying 'try again later' when your
 * organization does not accept feedback; it now shows the server's reason and
 * where to report a bug."
 *
 * Claudius's session-quality survey (FeedbackBanner) forwards through the
 * SDK's `submitFeedback`. The engine answers a refusal as a resolved
 * `{ feedback_id: null, unavailable_reason }`, which Claudius ignored — the
 * refused report showed "sent", and any failure blamed connectivity. Now
 * `/api/feedback` returns the refusal `reason` and the banner shows it next
 * to the existing "Open an issue" link. A failure with no reason keeps the
 * old copy, and an error response's machine code is never shown.
 *
 * The chat backend and `/api/feedback` are mocked; `interpretFeedbackResponse`
 * (the server half) has vitest coverage.
 *
 * Screenshot target: docs/cc-parity/2.1.309/feedback-refusal.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.309");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000309fb01";
const REFUSAL = "Your organization does not accept feedback.";

type SdkEvent = Record<string, unknown>;

async function mockChatBackend(page: Page): Promise<void> {
  const base: SdkEvent[] = [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-309fb", model: "claude-sonnet-4-6" } },
    {
      type: "sdk",
      message: {
        type: "user",
        uuid: "u-309fb-1",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "Summarize the open TODOs in lib/server" }] },
      },
    },
    {
      type: "sdk",
      message: {
        type: "assistant",
        uuid: "a-309fb-1",
        parent_tool_use_id: null,
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "There are three open TODOs: the scheduler retry cap, the MCP reconnect backoff, and the asset-store GC." }],
        },
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  // The survey nudge is ephemeral: a real reconnect never replays it, and a
  // completed mock response makes EventSource reconnect, so only the first
  // connection carries it (else the banner would be re-adopted mid-test).
  let connections = 0;
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    connections += 1;
    const events =
      connections === 1
        ? [...base.slice(0, -1), { type: "feedback_survey", sessionId: FAKE_SESSION_ID }, base[base.length - 1]]
        : base;
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
}

async function submitThumbsUp(page: Page): Promise<void> {
  const up = page.getByRole("button", { name: "Thumbs up" });
  await expect(up).toBeVisible({ timeout: 15_000 });
  await up.click();
  await page.locator('[data-pane-name="feedback-banner"]').getByRole("button", { name: /send/i }).click();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("a refused feedback forward shows the server's reason and where to report a bug", async ({ page }) => {
  let posted = 0;
  await page.route("**/api/feedback", (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted += 1;
    return route.fulfill({ json: { ok: true, stored: true, forwarded: false, reason: REFUSAL } });
  });
  await page.goto("/");
  await submitThumbsUp(page);

  const fail = page.getByTestId("feedback-banner-fail");
  await expect(fail).toBeVisible();
  await expect(page.getByTestId("feedback-refusal-reason")).toHaveText(REFUSAL);
  await expect(fail).toContainText("Saved locally — not sent:");
  // No connectivity framing when the server said why.
  await expect(fail).not.toContainText("couldn't reach Anthropic");
  // Where to report a bug.
  const issue = fail.getByRole("link", { name: /open an issue/i });
  await expect(issue).toHaveAttribute("href", "https://github.com/anthropics/claude-code/issues");
  expect(posted).toBe(1);

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "feedback-refusal.png"), fullPage: false });
});

test("a failure without a reason keeps the connectivity copy", async ({ page }) => {
  await page.route("**/api/feedback", (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { ok: true, stored: true, forwarded: false } });
  });
  await page.goto("/");
  await submitThumbsUp(page);

  const fail = page.getByTestId("feedback-banner-fail");
  await expect(fail).toBeVisible();
  await expect(fail).toContainText("Saved — but couldn't reach Anthropic");
  await expect(page.getByTestId("feedback-refusal-reason")).toHaveCount(0);
});

test("an error response's machine code is never shown as a refusal", async ({ page }) => {
  await page.route("**/api/feedback", (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 409,
      json: { ok: false, stored: false, forwarded: false, reason: "session-unavailable" },
    });
  });
  await page.goto("/");
  await submitThumbsUp(page);

  const fail = page.getByTestId("feedback-banner-fail");
  await expect(fail).toBeVisible();
  await expect(fail).toContainText("Couldn't submit your feedback");
  await expect(fail).not.toContainText("session-unavailable");
  await expect(page.getByTestId("feedback-refusal-reason")).toHaveCount(0);
});
