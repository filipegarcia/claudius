/**
 * Electron e2e — Workspace created "in web" appears in Electron rail.
 *
 * Coverage row: COVERAGE.md §9 "Web parity (same data both runtimes)".
 *
 * Scope
 * -----
 * Simulates the "two-runtime" scenario without spinning a second
 * browser: from the Electron renderer's already-mounted state, fire a
 * `POST /api/workspaces` (the same call the web UI would make), then
 * assert the new tile lands in the rail within a few seconds — i.e.
 * the Electron renderer either polls, subscribes to a workspace SSE,
 * or otherwise picks up the change without a manual reload.
 *
 * If the renderer DOESN'T auto-refresh, this test catches it: the
 * tile count stays flat, the timeout fires, and the spec records a
 * concrete repro of the parity gap.
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

// Wrapped in `test.fail()` because the renderer does NOT auto-refresh
// its workspace list when an external POST adds one. See
// `tests/electron/BUGS.md` → "Electron rail doesn't pick up cross-
// runtime workspace creation without a reload" for the full bug
// report.
test.fail("web-parity: workspace POSTed via API appears in rail without reload", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const rail = page.locator('aside[data-pane-name="workspace-switcher"]');
  await expect(rail).toBeVisible({ timeout: 30_000 });

  // Selector that captures only project workspace tiles — exclude the
  // "+ New workspace" button and the customizations drawer trigger
  // (same shape we used in iter 4's tile-count test).
  const tileButtons = page.locator(
    'aside[data-pane-name="workspace-switcher"] button[title]:not([title="New workspace"]):not([title^="Customizations"])',
  );
  const before = await tileButtons.count();
  expect(before, "fixture should have at least one project workspace").toBeGreaterThan(0);

  // POST a fresh workspace under a real on-disk path so the server-side
  // store accepts it (it realpaths the cwd before saving). The repo
  // root is always present.
  const port = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
  const createRes = await page.request.post(`http://localhost:${port}/api/workspaces`, {
    data: { name: `parity-${Date.now()}`, rootPath: process.cwd() },
  });
  expect(createRes.ok()).toBe(true);
  const created = (await createRes.json()) as { id: string };
  expect(created.id).toMatch(/^wks_[a-f0-9]+$/);

  // The rail must observe the new workspace within a reasonable
  // window. If the Electron renderer needs an explicit refresh, this
  // assertion will time out — and that's the bug we'd file.
  await expect(tileButtons).toHaveCount(before + 1, { timeout: 15_000 });
});
