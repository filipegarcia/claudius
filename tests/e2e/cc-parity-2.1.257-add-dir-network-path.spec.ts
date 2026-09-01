/**
 * CC 2.1.257 — "Changed --add-dir, /add-dir, and additionalDirectories to
 * refuse network paths (UNC shares, /net/<host> automounts) with a message
 * before touching them; on Windows use a mapped drive letter."
 *
 * Claudius's native `/add-dir` handler (`ChatSurface.tsx`) posts to
 * `/api/settings/additional-dirs`, which previously wrote any string
 * straight into `permissions.additionalDirectories` with no validation.
 * This spec drives the real chat composer and hits the real (unmocked)
 * route — safe to do because the network-path guard short-circuits before
 * `readSettings`/`writeSettings` ever run, so no real settings.json write
 * happens for the rejected path.
 *
 * Screenshot target: docs/cc-parity/2.1.257/add-dir-network-path-rejected.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.257");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.257 — /add-dir refuses network paths", () => {
  test("a UNC share path is rejected with a toast, not silently added", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await composer.click();
    await composer.pressSequentially("/add-dir \\\\fileserver\\share\\project", { delay: 20 });
    await page.waitForTimeout(150);
    await composer.press("Enter");

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/network path/i);
    await expect(toast).toContainText(/mapped drive letter/i);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "add-dir-network-path-rejected.png"),
      fullPage: false,
    });
  });
});
