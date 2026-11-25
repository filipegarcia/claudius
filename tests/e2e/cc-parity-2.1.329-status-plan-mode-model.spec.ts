/**
 * CC 2.1.329 parity — "Fixed `/status` not naming the model that opusplan and
 * haiku use in plan mode".
 *
 * With the session on `opusplan`, /status's Model row now reads
 * "opusplan · Opus 5.5 in plan mode, up to 200k tokens", the version named
 * from the session's model catalog (mocked here).
 *
 * Screenshot target: docs/cc-parity/2.1.329/status-plan-mode-model.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.329");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002329p01";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/status names the model opusplan uses in plan mode", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-329p"),
    { type: "model_changed", model: "opusplan" },
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${SESSION}/model`, (route: Route) =>
    route.fulfill({
      json: {
        models: [
          { value: "default", displayName: "Default", description: "", resolvedModel: "claude-sonnet-5-5" },
          { value: "opus", displayName: "Opus", description: "", resolvedModel: "claude-opus-5-5" },
          { value: "sonnet", displayName: "Sonnet", description: "", resolvedModel: "claude-sonnet-5-5" },
        ],
      },
    }),
  );

  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("/status");
  await page.getByTestId("prompt-send").click();
  await expect(page.getByText("Session status")).toBeVisible({ timeout: 5_000 });

  await expect(page.getByTestId("status-plan-mode-model")).toHaveText(
    " · Opus 5.5 in plan mode, up to 200k tokens",
    { timeout: 5_000 },
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "status-plan-mode-model.png"), fullPage: false });
});
