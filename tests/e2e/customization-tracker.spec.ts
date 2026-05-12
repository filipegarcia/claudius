import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Screenshot for the Tracker customization on the marketing site.
 *
 * The page is fully self-contained — fixture data is hardcoded in
 * `app/tracker/page.tsx`, so no API routes need mocking. We just navigate,
 * wait for the issues list to render, and snap.
 *
 * Activates the "claudius" workspace first so the side nav reflects this
 * project (matching the rest of the marketing screenshots) — the Tracker
 * tile only appears when a workspace-scoped layout is active.
 *
 * Output: site/screenshots/customization-tracker.png — referenced from
 * site/index.html in the customizations gallery.
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
});

test.describe("customization · tracker screenshot", () => {
  test("customization-tracker", async ({ page }) => {
    await page.goto("/tracker", { waitUntil: "load" });
    // The page is a single client component — the testid is rendered on
    // first paint, but we still wait so any web-font swap settles before
    // the snap.
    await expect(page.getByTestId("tracker-page")).toBeVisible({ timeout: 10_000 });
    // Sanity: at least one fixture issue must be present. Catches a
    // regression where the fixture array gets nulled or the filter pre-
    // selects an empty state by accident. `.first()` avoids the strict-
    // mode collision on the multi-issue regex.
    await expect(page.getByText(/#48[0-9]/).first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "customization-tracker.png"),
      fullPage: false,
    });
  });
});
