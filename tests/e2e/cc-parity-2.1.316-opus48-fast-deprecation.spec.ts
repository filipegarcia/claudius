/**
 * CC 2.1.316 parity — "Deprecated fast mode for Opus 4.8 as of October 30,
 * 2026; it will be removed on November 30, 2026…Migrate to Opus 5.5 to keep
 * the speedup".
 *
 * The 2.1.316 engine emits `system/notification` key
 * `opus48-fast-mode-deprecation` only from its own `/fast` command / TUI
 * picker. Claudius's picker toggles fast through `applyFlagSettings`, which
 * never emits it, so Claudius shows the engine's text itself: an amber line
 * under the picker's Fast toggle while the active model is Opus 4.8, and an
 * amber FastModeNoticePanel strip when fast mode is turned on there.
 *
 * The clock is pinned before the removal date so the spec doesn't expire.
 *
 * Screenshot target: docs/cc-parity/2.1.316/opus48-fast-deprecation.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000316o48f";
const ENGINE_TEXT = "Opus 4.8 fast mode is deprecated and will be removed on Nov 30";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const MODELS = [
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Previous-generation Opus.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "Most capable for complex work.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
];

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-316o48", model: "claude-opus-4-8" } },
  {
    type: "sdk",
    message: { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Speed up the test suite." }] } },
  },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(PRELUDE),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: MODELS }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  const fastPosts: boolean[] = [];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/fast`, async (route: Route) => {
    fastPosts.push(Boolean((route.request().postDataJSON() as { enabled?: boolean })?.enabled));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
  return { fastPosts };
}

test.beforeEach(async ({ page }) => {
  // Before the Nov 30 removal, so the notice still applies.
  await page.clock.setFixedTime(new Date("2026-10-31T12:00:00Z"));
  await activateClaudiusWorkspace(page);
});

test("turning fast mode on for Opus 4.8 warns that it is deprecated", async ({ page }) => {
  const state = await mockChatBackend(page);
  await page.goto("/");

  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Opus 4.8", { timeout: 30_000 });
  await trigger.click();
  const panel = page.getByTestId("model-picker-panel");
  await expect(panel).toBeVisible();

  // The picker row warns before the user even turns it on.
  const rowWarning = panel.getByTestId("model-picker-fast-deprecation");
  await expect(rowWarning).toBeVisible();
  await expect(rowWarning).toContainText(ENGINE_TEXT);
  await expect(rowWarning).toContainText("Switch to Opus 5.5 to keep the speedup.");

  // Turning it on still works, and raises the amber notice strip.
  await panel.getByTestId("model-picker-fast").click();
  await expect.poll(() => state.fastPosts).toEqual([true]);
  const notice = page.locator('[data-fast-mode-notice="deprecation"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Opus 4.8 fast mode is deprecated");
  await expect(notice).toContainText("Switch to Opus 5.5 to keep the speedup.");
  await expect(notice).toHaveClass(/amber/);

  // Reopen the picker so the shot shows the strip and the row warning.
  await trigger.click();
  await expect(rowWarning).toBeVisible();
  await rowWarning.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "opus48-fast-deprecation.png"), fullPage: false });

  // Dismissible like its siblings.
  await page.keyboard.press("Escape");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});

test("Opus 5.5 (the opus alias) shows no deprecation", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Opus 4.8", { timeout: 30_000 });
  await trigger.click();
  const panel = page.getByTestId("model-picker-panel");
  await panel.locator('[data-testid="model-picker-option"][data-model="opus"]').click();
  await expect(panel.locator('[data-testid="model-picker-option"][data-model="opus"]')).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("model-picker-fast")).toBeVisible();
  await expect(panel.getByTestId("model-picker-fast-deprecation")).toHaveCount(0);
  await panel.getByTestId("model-picker-fast").click();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-fast-mode-notice="deprecation"]')).toHaveCount(0);
});
