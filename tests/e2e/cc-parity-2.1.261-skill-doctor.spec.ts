/**
 * CC 2.1.261 parity — "Added `/skill-doctor` to show which loaded skills go
 * unused and what they cost in context, so you can prune them."
 *
 * Claudius already renders a per-session context-usage breakdown
 * (ContextOverlay.tsx, opened via `/context`) built directly on the SDK's
 * `getContextUsage()` response — which already carries a per-skill token
 * cost (`skills.skillFrontmatter`) that the overlay wasn't rendering. This
 * release adds that "Skills" section (sorted priciest-first, the shape a
 * user pruning skills cares about) and a new `/skill-doctor` slash command
 * that opens the same overlay — see lib/shared/slash-commands.ts and
 * ChatSurface.tsx's `runNative` dispatcher.
 *
 * Claudius deliberately does NOT ship the "unused" half: the SDK's
 * getContextUsage() response has no per-skill invocation flag, and the
 * `Skill` tool's input isn't a typed, documented shape Claudius can safely
 * pattern-match against the transcript — see run-notes "Risks / follow-ups"
 * for the full reasoning. This spec covers the cost half only.
 *
 * Screenshot target: docs/cc-parity/2.1.261/skill-doctor-context-cost.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.261");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const CONTEXT_RESPONSE = {
  categories: [
    { name: "System prompt", tokens: 4000, color: "claude" },
    { name: "Messages", tokens: 2000, color: "text" },
    { name: "Free space", tokens: 194_000, color: "inactive" },
  ],
  totalTokens: 6000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 3,
  gridRows: [],
  model: "claude-sonnet-4-6",
  memoryFiles: [],
  mcpTools: [],
  // The cost half of /skill-doctor: three loaded skills, deliberately out
  // of cost order in the fixture so the test can prove the overlay sorts
  // priciest-first rather than echoing SDK order.
  skills: {
    totalSkills: 4,
    includedSkills: 3,
    tokens: 3300,
    skillFrontmatter: [
      { name: "code-review", source: "userSettings", tokens: 900 },
      { name: "dataviz", source: "plugin", tokens: 2100 },
      { name: "loop", source: "userSettings", tokens: 300 },
    ],
  },
};

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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONTEXT_RESPONSE),
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

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("/skill-doctor — per-skill context cost in the Context overlay (CC 2.1.261 parity)", () => {
  test("opens the Context overlay and shows skills sorted priciest-first", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    // Fill + click Send rather than press Enter — Enter is intercepted by
    // the slash-autocomplete menu instead of submitting (same pattern as
    // cc-parity-2.1.251-cost-overlay-cache-spend.spec.ts).
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/skill-doctor");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByText("Context window")).toBeVisible({ timeout: 15_000 });

    const rows = page.getByTestId("skill-cost-row");
    await expect(rows).toHaveCount(3);

    // Priciest first: dataviz (2100) > code-review (900) > loop (300),
    // even though the fixture lists them in a different order.
    await expect(rows.nth(0)).toContainText("dataviz");
    await expect(rows.nth(0)).toContainText("2.1K");
    await expect(rows.nth(1)).toContainText("code-review");
    await expect(rows.nth(2)).toContainText("loop");

    await expect(page.getByText("3/4 loaded")).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "skill-doctor-context-cost.png"),
      fullPage: false,
    });
  });

  test("Skills section stays hidden when the session reports no skills", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...CONTEXT_RESPONSE, skills: undefined }),
      });
    });
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/context");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByText("Context window")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("skill-cost-row")).toHaveCount(0);
  });
});
