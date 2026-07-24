/**
 * SDK 0.3.219 — `DirectoryAdded` lifecycle hook event.
 *
 * The changelog adds a new control-protocol hook event, fired when a new
 * working directory is registered mid-session (`/add-dir`, or the SDK's
 * `register_repo_root` control request). Claudius mirrors the SDK's
 * `HOOK_EVENTS` const in `lib/shared/hook-events.ts` for the `/hooks`
 * editor — this spec confirms the new event actually reaches that UI, not
 * just the shared type file (a type-only edit here would leave `/hooks`
 * silently missing the new event with no test catching it).
 *
 * Screenshot target: docs/sdk-updates/0.3.219/directory-added-hook.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.219");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("DirectoryAdded hook event (SDK 0.3.219)", () => {
  test("/hooks lists DirectoryAdded under Worktrees & files", async ({ page }) => {
    await page.goto("/hooks");

    // Narrow to the new event so the "Worktrees & files" section it lives in
    // is the one on screen (the full page has ~10 sections).
    await page.getByLabel("Search hooks").fill("DirectoryAdded");

    const sectionHeader = page.getByText("Worktrees & files", { exact: true });
    await expect(sectionHeader).toBeVisible({ timeout: 15_000 });

    const row = page.getByText("DirectoryAdded", { exact: true });
    await expect(row).toBeVisible();
    await expect(
      page.getByText(/new working directory is registered mid-session/i),
    ).toBeVisible();

    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "directory-added-hook.png"),
      fullPage: false,
    });
  });
});
