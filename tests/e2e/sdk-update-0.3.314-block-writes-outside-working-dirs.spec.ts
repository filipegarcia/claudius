/**
 * SDK 0.3.314 — `Settings.permissions.blockWritesOutsideWorkingDirectories`
 * ("Refuse file-tool writes (Write, Edit, NotebookEdit) outside the working
 * directories in every permission mode"). Surfaced as a per-scope toggle on
 * `/permissions`, directly under the CC 2.1.257 reads toggle.
 *
 * GET/POST to `/api/settings/permissions` are mocked so the spec never
 * touches the real fixture settings.json.
 *
 * Screenshot target: docs/sdk-updates/0.3.314/block-writes-outside-working-dirs.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.314");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = {
  allow: [],
  ask: [],
  deny: [],
  blockReadsOutsideWorkingDirectories: false,
  blockWritesOutsideWorkingDirectories: false,
};

test.describe("Block writes outside working directories toggle (SDK 0.3.314)", () => {
  let lastPatch: unknown = null;

  test.beforeEach(async ({ page }) => {
    lastPatch = null;
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: EMPTY_RULES, project: EMPTY_RULES, local: EMPTY_RULES }),
        });
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { patch?: unknown };
        lastPatch = body?.patch;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fallback();
    });
    await page.route("**/api/sessions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      return route.fallback();
    });
    await page.goto("/permissions");
  });

  test("toggling patches blockWritesOutsideWorkingDirectories for the active scope", async ({ page }) => {
    const toggle = page.getByTestId("block-writes-outside-working-dirs");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("block-reads-outside-working-dirs")).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(() => lastPatch).toEqual({ blockWritesOutsideWorkingDirectories: true });
    // Independent of the reads flag.
    await expect(page.getByTestId("block-reads-outside-working-dirs")).not.toBeChecked();

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "block-writes-outside-working-dirs.png"),
      fullPage: false,
    });

    await toggle.uncheck();
    await expect.poll(() => lastPatch).toEqual({ blockWritesOutsideWorkingDirectories: false });
  });
});
