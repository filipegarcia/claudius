/**
 * Electron e2e — Workspace rail tile count matches the API.
 *
 * Coverage row: COVERAGE.md §7 "App features — workspace switcher + rail".
 *
 * Scope
 * -----
 * The workspace rail in `components/nav/WorkspaceSwitcher.tsx` renders
 * one `<button title="<name>…">` per non-customization workspace from
 * `/api/workspaces`. This test fetches the API directly, computes the
 * expected number of *project* tiles (excluding `kind === "customization"`),
 * then asserts the DOM exposes the same count.
 *
 * Why fetch the API instead of hard-coding a count: the e2e tempdir
 * `HOME` (set by playwright.config.ts) auto-bootstraps one default
 * workspace, but the dev server can mutate that across runs. Comparing
 * DOM to API decouples the assertion from any specific seed state.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

type WorkspaceSummary = {
  id: string;
  name: string;
  kind?: "project" | "customization";
};

test("workspace-rail: tile count matches /api/workspaces project count", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Wait on the rail itself first so we know the WorkspaceSwitcher
  // has mounted. The `<aside data-pane-name="workspace-switcher">` is
  // the structural marker — it's present in both the desktop and
  // mobile-overlay layouts (the mobile-toggle testid is hidden at
  // desktop widths so it's a poor mount signal here).
  const rail = page.locator('aside[data-pane-name="workspace-switcher"]');
  await expect(rail).toBeVisible({ timeout: 30_000 });

  // Pull the source of truth.
  const port = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
  const res = await page.request.get(`http://localhost:${port}/api/workspaces`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { workspaces: WorkspaceSummary[] };
  const projectIds = body.workspaces
    .filter((w) => (w.kind ?? "project") === "project")
    .map((w) => w.id);
  expect(projectIds.length, "fixture should have at least one project workspace").toBeGreaterThan(0);

  // Each project tile is rendered as a `<button title="<name>…">` with
  // a `<WorkspaceIcon size={40}>` inside. The buttons live as direct
  // children of the rail `<aside data-pane-name="workspace-switcher">`.
  // We count those buttons and require they equal the API projection.
  // (The "+ New workspace" tile uses `title="New workspace"` so it
  // doesn't get counted here; the CustomizationsDrawer button uses
  // a different title.)
  const tileButtons = page.locator(
    'aside[data-pane-name="workspace-switcher"] button[title]:not([title="New workspace"]):not([title^="Customizations"])',
  );
  await expect(tileButtons).toHaveCount(projectIds.length, { timeout: 10_000 });
});
