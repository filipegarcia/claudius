/**
 * CC 2.1.207 — "Auto mode is now available without CLAUDE_CODE_ENABLE_AUTO_MODE
 * opt-in on Bedrock, Vertex AI, and Foundry; disable via `disableAutoMode` in
 * settings."
 *
 * Claudius already ships "auto" as a full permission mode (ModeSelector +
 * Shift+Tab cycling) — that's SDK-driven and needs no work here. What's new
 * in 2.1.207 is the settings escape hatch: `disableAutoMode` in
 * `~/.claude/settings.json`. This spec drives the real setting through the
 * generic SDK-settings catalog on `/settings` (Permissions section) and
 * verifies:
 *   1. the toggle round-trips through the settings API,
 *   2. once set, the ModeSelector dropdown no longer offers "Auto" at all
 *      (`Session.setPermissionMode` independently enforces the same gate
 *      server-side — see `tests/unit` for the pure cycling-math coverage of
 *      `nextPermissionMode`'s `disabledModes` param).
 *
 * Screenshot target: docs/cc-parity/2.1.207/disable-auto-mode.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.207");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/** Clear `disableAutoMode` from the shared dev fixture's user-scope settings. */
async function clearDisableAutoMode(page: Page): Promise<void> {
  const cur = await page.request
    .get("/api/settings?scope=user")
    .then((r) => r.json() as Promise<{ settings: Record<string, unknown> }>);
  const rest = { ...cur.settings };
  delete rest.disableAutoMode;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  // Start from a clean slate — clear any `disableAutoMode` left over from a
  // prior run so every test in this file sees Auto mode enabled by default.
  await clearDisableAutoMode(page);
});

test.afterEach(async ({ page }) => {
  await clearDisableAutoMode(page);
});

test.describe("CC 2.1.207 — disableAutoMode settings escape hatch", () => {
  test("the Permissions catalog exposes disableAutoMode and it hides Auto from the mode picker", async ({
    page,
  }) => {
    // ── 1. Before setting anything, Auto is offered normally ─────────────
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const trigger = page.getByTestId("mode-selector-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    await expect(page.getByTestId("mode-selector-option-auto")).toBeVisible();
    await page.keyboard.press("Escape");

    // ── 2. Flip the setting via the real Settings UI ─────────────────────
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("disableAutoMode");
    const field = page.getByTestId("catalog-field-disableAutoMode");
    await expect(field).toBeVisible({ timeout: 15_000 });
    await field.locator("select").selectOption("disable");
    await page.getByRole("button", { name: /^Save$/ }).click();

    // Round-trips through the API.
    await expect
      .poll(async () => {
        const r = await page.request.get("/api/settings?scope=user");
        const body = (await r.json()) as { settings: { disableAutoMode?: string } };
        return body.settings.disableAutoMode;
      }, { timeout: 10_000 })
      .toBe("disable");

    // Saving triggers a settings refetch that resets the search box (a
    // pre-existing quirk of the settings page, unrelated to this feature) —
    // re-apply the filter so the screenshot shows the Permissions row in
    // context, not whatever section happens to be at the top of an
    // unfiltered page.
    await page.getByLabel("Search settings").fill("disableAutoMode");
    await expect(field).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "disable-auto-mode-settings.png"),
      fullPage: false,
    });

    // ── 3. Back in chat, "Auto" is gone from the picker ──────────────────
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    await expect(page.getByTestId("mode-selector-option-default")).toBeVisible();
    await expect(page.getByTestId("mode-selector-option-auto")).toHaveCount(0);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "disable-auto-mode-picker.png"),
      fullPage: false,
    });
  });
});
