/**
 * SDK 0.3.251 — `PreModelSwitch` / `PostModelSwitch` lifecycle hook events.
 *
 * The changelog is a bare "parity with Claude Code v2.1.251" line, but the
 * SDK's `.d.ts` diff adds two new control-protocol hook events fired around
 * a mid-session model change (command, picker, sdk, automatic fallback, or
 * resume). Claudius mirrors the SDK's `HOOK_EVENTS` const in
 * `lib/shared/hook-events.ts` for the `/hooks` editor, under a new "Model
 * switching" category — this spec confirms both events actually reach that
 * UI, not just the shared type file (a type-only edit here would leave
 * `/hooks` silently missing the new events with no test catching it).
 *
 * Screenshot target: docs/sdk-updates/0.3.251/model-switch-hooks.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.251");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("PreModelSwitch / PostModelSwitch hook events (SDK 0.3.251)", () => {
  test("/hooks lists both events under a new 'Model switching' section", async ({ page }) => {
    await page.goto("/hooks");

    // Narrow to the new events so the "Model switching" section they live in
    // is the one on screen (the full page has ~10 sections).
    await page.getByLabel("Search hooks").fill("ModelSwitch");

    const sectionHeader = page.getByText("Model switching", { exact: true });
    await expect(sectionHeader).toBeVisible({ timeout: 15_000 });

    const preRow = page.getByText("PreModelSwitch", { exact: true });
    const postRow = page.getByText("PostModelSwitch", { exact: true });
    await expect(preRow).toBeVisible();
    await expect(postRow).toBeVisible();
    await expect(
      page.getByText(/before the model changes mid-session/i),
    ).toBeVisible();
    await expect(
      page.getByText(/after the model changes mid-session/i),
    ).toBeVisible();

    // PreModelSwitch can block (allow/deny/ask) — the amber badge mirrors
    // the same affordance already shown for PreToolUse/PreCompact/Stop.
    const preItem = page.locator("li", { has: preRow });
    await expect(preItem.getByText("can block")).toBeVisible();

    await sectionHeader.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "model-switch-hooks.png"),
      fullPage: false,
    });
  });
});
