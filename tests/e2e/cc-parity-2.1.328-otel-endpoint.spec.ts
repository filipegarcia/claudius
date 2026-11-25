/**
 * CC 2.1.328 parity — "Added a notice in `/status` and `claude doctor` when
 * an OpenTelemetry exporter has no endpoint and its data would likely be
 * lost".
 *
 * Claudius draws its own /status overlay and /doctor page, so the engine's
 * notice never reached either one. The shared problem list behind
 * `/api/doctor/files` and `/api/doctor` now carries it (the rule itself is
 * covered by tests/unit/cc-parity-2.1.328-otel-endpoint.test.ts): /status
 * counts it and shows the engine's text, and /doctor lists it in the Config
 * files section with a link to Settings → Environment.
 *
 * Both endpoints are mocked here.
 *
 * Screenshot targets: docs/cc-parity/2.1.328/otel-endpoint.png (/status),
 * docs/cc-parity/2.1.328/otel-endpoint-doctor.png (/doctor)
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002328o01";

const NOTICE =
  "OpenTelemetry: No endpoint or protocol is set for metrics, so telemetry can't start. " +
  "Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, or take otlp out of " +
  "OTEL_METRICS_EXPORTER. Then restart Claude Code.";

const PROBLEM = { kind: "telemetry", scope: "user", name: "OpenTelemetry", path: "env:OpenTelemetry", reason: NOTICE };

const CHECK = {
  id: "config-file:telemetry",
  label: "OpenTelemetry exporter has no endpoint",
  status: "warn",
  detail: NOTICE,
  link: { href: "/settings", label: "Open Settings → Environment" },
  category: "config-files",
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/status and /doctor flag an OpenTelemetry exporter with no endpoint", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-328o"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route("**/api/doctor/files*", (route: Route) =>
    route.fulfill({ json: { problems: [PROBLEM], checks: [CHECK] } }),
  );
  await page.route("**/api/doctor", (route: Route) =>
    route.fulfill({
      json: {
        runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" },
        sdk: { version: "0.3.332" },
        checks: [
          { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
          CHECK,
          {
            id: "config-file:agents-skills",
            label: "Agent and skill files",
            status: "ok",
            detail: "No broken agent or skill files found.",
            category: "config-files",
          },
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

  await expect(page.getByTestId("status-problems")).toContainText("1 problem");
  await expect(page.getByTestId("status-notice")).toHaveText(NOTICE);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "otel-endpoint.png"), fullPage: false });

  await page.getByTestId("status-problems-link").click();
  await expect(page).toHaveURL(/\/doctor\?section=config-files$/);
  const section = page.getByTestId("doctor-config-files-section");
  await expect(section).toBeVisible({ timeout: 15_000 });
  const row = section.locator("li", { hasText: "OpenTelemetry exporter has no endpoint" });
  await expect(row).toContainText("so telemetry can't start");
  await expect(page.getByTestId("doctor-link-config-file:telemetry")).toHaveText("Open Settings → Environment");
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "otel-endpoint-doctor.png"), fullPage: false });
});
