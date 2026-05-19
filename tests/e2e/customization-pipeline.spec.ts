import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { UPDATE_SCREENSHOTS } from "./helpers/marketing-screenshot";

/**
 * Screenshot for the Data Pipeline customization on the marketing site.
 *
 * The page is fully self-contained — fixture data is hardcoded in
 * `app/pipeline/page.tsx`, so we don't need to mock any API routes. We
 * just navigate, wait for the DAG to render, and snap.
 *
 * Two shots (only written when UPDATE_SCREENSHOTS=1):
 *   1. customization-pipeline.png        — the full dashboard
 *   2. customization-pipeline-graph.png  — close-up on just the DAG
 *      (for a punchier hero crop on the marketing card)
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

type WorkspaceSummary = { id: string; name: string; rootPath: string };

async function activateClaudiusWorkspace(page: Page) {
  const list = await page.request
    .get("/api/workspaces")
    .then((r) => r.json() as Promise<{ workspaces: WorkspaceSummary[] }>);
  const cwd = process.cwd();
  const ws =
    list.workspaces.find((w) => w.name === "claudius") ??
    list.workspaces.find((w) => w.rootPath === cwd);
  if (ws) {
    await page.request.post(`/api/workspaces/${ws.id}/select`);
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  // The DAG is wider than the default 1280 viewport — give it room so the
  // last column doesn't clip in the screenshot.
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test.describe("customization · data pipeline screenshots", () => {
  test("customization-pipeline (overview)", async ({ page }) => {
    await page.goto("/pipeline", { waitUntil: "load" });
    await expect(page.getByTestId("pipeline-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pipeline-graph")).toBeVisible();
    // Let the SVG drop-shadows settle and any layout reflow complete.
    await page.waitForTimeout(500);
    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-pipeline.png"),
        fullPage: false,
      });
    }
  });

  test("customization-pipeline-graph (DAG close-up)", async ({ page }) => {
    await page.goto("/pipeline", { waitUntil: "load" });
    const graph = page.getByTestId("pipeline-graph");
    await expect(graph).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    if (UPDATE_SCREENSHOTS) {
      await graph.screenshot({
        path: resolve(SHOTS_DIR, "customization-pipeline-graph.png"),
      });
    }
  });
});
