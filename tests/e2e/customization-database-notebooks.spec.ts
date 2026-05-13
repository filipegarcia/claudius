import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Marketing screenshots for the Database (SQL console) and Notebooks
 * (Jupyter-style) customizations.
 *
 * Both pages are fully self-contained — the fixtures live inside the page
 * components themselves, no API mocking needed. We bump the viewport to
 * give the SQL editor room for its DataGrip-style layout and snap each
 * route once. The notebook also takes a tighter "single cell" shot for
 * the marketing card hero.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });

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
  // Database SQL pane + DB tree are wider than the default 1280; bump
  // viewport so neither pane gets clipped in the shot.
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test.describe("customization · database + notebooks screenshots", () => {
  test("customization-database (SQL console)", async ({ page }) => {
    await page.goto("/database", { waitUntil: "load" });
    await expect(page.getByTestId("database-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("database-tabs")).toBeVisible();
    // Settle: syntax-highlight rendering + tree expansion.
    await page.waitForTimeout(400);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "customization-database.png"),
      fullPage: false,
    });
  });

  test("customization-notebooks (Jupyter runner)", async ({ page }) => {
    await page.goto("/notebooks", { waitUntil: "load" });
    await expect(page.getByTestId("notebooks-page")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "customization-notebooks.png"),
      fullPage: false,
    });
  });
});
