/**
 * CC 2.1.321 parity — "Changed the fast mode labels in /fast, /config and
 * /model to name your current model when it supports fast mode".
 *
 * Claudius's `/fast` (bare) and `/model` both open the session card's
 * ModelPicker, whose Fast toggle only appears on a model that supports fast
 * mode. Its label read a bare "Fast mode"; it now names the model, as the
 * engine does: "Fast mode (Fable 5.2)" — Fable 5.2 is also new in this
 * release and is fast-capable in the engine catalog — and "Fast mode
 * (Opus 5.5)" once the `opus` alias (resolved to Opus 5.5) is picked.
 *
 * Screenshot target: docs/cc-parity/2.1.321/fast-mode-label.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000321fast";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const MODELS = [
  {
    value: "claude-fable-5-2",
    displayName: "Fable 5.2",
    description: "Most capable for your hardest and longest-running tasks.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "Best for everyday, complex tasks.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Efficient for routine tasks.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

async function mockChatBackend(page: Page, initExtra: Record<string, unknown> = {}) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody([
        { type: "ready", sessionId: FAKE_SESSION_ID },
        { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-321f", model: "claude-fable-5-2", ...initExtra } },
        {
          type: "sdk",
          message: { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Profile the slow import path." }] } },
        },
        { type: "replay_done", hasMoreAbove: false },
      ]),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: MODELS }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/fast`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the Fast mode toggle names the current model", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");

  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Fable 5.2", { timeout: 30_000 });
  await trigger.click();
  const panel = page.getByTestId("model-picker-panel");
  await expect(panel).toBeVisible();

  const label = panel.getByTestId("model-picker-fast-label");
  await expect(label).toHaveText("Fast mode (Fable 5.2)");
  await panel.getByTestId("model-picker-fast").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "fast-mode-label.png"), fullPage: false });

  // CC 2.1.321 — the per-row "Draws from usage credits" note shows only while
  // fast mode is on (Fable 5.2 is fast-capable, so it used to sit on every
  // Fable row, plan-included seats too). The `fast` chip stays.
  const fableRow = panel.locator('[data-testid="model-picker-option"][data-model="claude-fable-5-2"]');
  await expect(fableRow).toContainText("fast");
  await expect(panel.getByTestId("model-picker-row-credits")).toHaveCount(0);
  // Turning fast on closes the picker (like picking a model); reopen it.
  await panel.getByTestId("model-picker-fast").click();
  await expect(panel).toBeHidden();
  await trigger.click();
  await expect(panel.getByTestId("model-picker-fast")).toHaveAttribute("aria-pressed", "true");
  await expect(fableRow.getByTestId("model-picker-row-credits")).toHaveText("Draws from usage credits");

  // Switching to the opus alias relabels the row with its resolved model.
  await panel.locator('[data-testid="model-picker-option"][data-model="opus"]').click();
  await expect(panel.locator('[data-testid="model-picker-option"][data-model="opus"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(label).toHaveText("Fast mode (Opus 5.5)");

  // A model without fast mode has no toggle at all.
  await panel.locator('[data-testid="model-picker-option"][data-model="sonnet"]').click();
  await expect(panel.getByTestId("model-picker-fast")).toHaveCount(0);
});

test("fast mode already on (SDK-reported, e.g. after a reload) shows the credits note", async ({ page }) => {
  // The picker's own toggle state resets on reload; the engine still reports
  // fast mode on. The billing note must follow the engine, not the toggle.
  await mockChatBackend(page, { fast_mode_state: "on" });
  await page.goto("/");
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Fable 5.2", { timeout: 30_000 });
  await trigger.click();
  const panel = page.getByTestId("model-picker-panel");
  const fableRow = panel.locator('[data-testid="model-picker-option"][data-model="claude-fable-5-2"]');
  await expect(fableRow.getByTestId("model-picker-row-credits")).toHaveText("Draws from usage credits");
  // A model without fast mode never shows it.
  const sonnetRow = panel.locator('[data-testid="model-picker-option"][data-model="sonnet"]');
  await expect(sonnetRow.getByTestId("model-picker-row-credits")).toHaveCount(0);
});
