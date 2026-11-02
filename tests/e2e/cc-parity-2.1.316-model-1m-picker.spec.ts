/**
 * CC 2.1.316 parity — "[VSCode] Fixed the missing Effort slider, Ultracode
 * switch and model name when the model setting has the [1m] tag, such as
 * opus[1m]".
 *
 * The engine's `supportedModels()` lists Opus 5.5 as plain `opus` (the `[1m]`
 * tag has no effect on a natively-1M model), so a session on `opus[1m]` found
 * no row by exact `value`: the ModelPicker dropped its Effort row, the
 * Ultracode chip and toggle, the Fast toggle, and the row's check mark.
 * `findModelEntry` (lib/shared/model-id.ts) now falls back to a
 * `[1m]`-insensitive match.
 *
 * Screenshot target: docs/cc-parity/2.1.316/model-1m-picker.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000316m1m1";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const MODELS = [
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Balanced speed and quality.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
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
  // The model setting carries the `[1m]` tag; the catalog row doesn't.
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-316m1m", model: "opus[1m]" } },
  {
    type: "sdk",
    message: { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Refactor the session reaper." }] } },
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
  for (const leaf of ["fast", "ultracode", "effort"]) {
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/${leaf}`, async (route: Route) => {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
  }
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
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an opus[1m] session keeps its Effort, Ultracode and Fast controls in the picker", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");

  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("opus[1m]", { timeout: 30_000 });
  await trigger.click();
  const panel = page.getByTestId("model-picker-panel");
  await expect(panel).toBeVisible();

  // The opus row is the current one (and only it).
  const opusRow = panel.locator('[data-testid="model-picker-option"][data-model="opus"]');
  await expect(opusRow).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator('[data-testid="model-picker-option"][aria-selected="true"]')).toHaveCount(1);

  // Effort row for Opus 5.5, including the Ultracode chip (xhigh-capable).
  const effort = panel.getByTestId("model-picker-effort");
  await expect(effort.filter({ hasText: "Very High" })).toBeVisible();
  await expect(effort.filter({ hasText: "Max" })).toBeVisible();
  await expect(panel.locator('[data-testid="model-picker-effort"][data-effort="ultracode"]')).toBeVisible();
  await expect(panel.getByText("Opus 5.5", { exact: true }).first()).toBeVisible();

  // The Dynamic Workflows (ultracode) toggle and the Fast toggle.
  await expect(panel.getByTestId("model-picker-ultracode")).toBeVisible();
  await expect(panel.getByTestId("model-picker-fast")).toBeVisible();

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "model-1m-picker.png"), fullPage: false });
});
