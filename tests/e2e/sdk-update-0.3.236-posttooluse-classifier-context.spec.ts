/**
 * SDK 0.3.236 — `PostToolUse` hooks can return
 * `hookSpecificOutput.classifierContext`, a short host-asserted note about a
 * tool call's result that the auto-mode permission classifier reads
 * alongside that result.
 *
 * Claudius mirrors the SDK's `HOOK_EVENTS` const in
 * `lib/shared/hook-events.ts` for the `/hooks` editor — this spec confirms
 * the new capability is documented where a user composing a `PostToolUse`
 * hook would actually see it (a type-only edit to the shared metadata file
 * would leave `/hooks` silently missing the callout, with no test to catch
 * it — see the `DirectoryAdded` precedent in
 * sdk-update-0.3.219-directory-added-hook.spec.ts).
 *
 * Screenshot target:
 * docs/sdk-updates/0.3.236/posttooluse-classifier-context.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.236");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("PostToolUse classifierContext (SDK 0.3.236)", () => {
  test("/hooks documents classifierContext on the PostToolUse row", async ({ page }) => {
    await page.goto("/hooks");

    // Narrow to PostToolUse so the "Tool lifecycle" section it lives in is
    // the one on screen (the full page has ~10 sections).
    await page.getByLabel("Search hooks").fill("PostToolUse");

    const sectionHeader = page.getByText("Tool lifecycle", { exact: true });
    await expect(sectionHeader).toBeVisible({ timeout: 15_000 });

    const row = page.getByText("PostToolUse", { exact: true });
    await expect(row).toBeVisible();
    await expect(
      page.getByText(/classifierContext to inform the auto-mode permission classifier/i),
    ).toBeVisible();

    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "posttooluse-classifier-context.png"),
      fullPage: false,
    });
  });
});
