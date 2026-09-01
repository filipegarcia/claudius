/**
 * CC 2.1.257 — "Added a one-time prompt in auto mode before the first file
 * read outside the working directories, with the option to block such
 * reads (permissions.blockReadsOutsideWorkingDirectories)."
 *
 * Claudius has no one-time-prompt UI to hook this into (auto mode's
 * classifier runs server-side, inside the SDK) — the setting itself is
 * surfaced as a plain toggle on `/permissions`, in the same "Rules" tab as
 * the allow/ask/deny columns, next to the scope selector it's scoped by.
 *
 * The GET/POST to `/api/settings/permissions` are mocked so this spec
 * never touches the real dev fixture's settings.json (same approach as
 * `cc-parity-2.1.210-permission-rule-warning.spec.ts`).
 *
 * Screenshot target: docs/cc-parity/2.1.257/block-reads-outside-working-dirs.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.257");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false };

test.describe("Block reads outside working directories toggle (CC 2.1.257)", () => {
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

  test("toggling the checkbox patches blockReadsOutsideWorkingDirectories for the active scope", async ({
    page,
  }) => {
    const toggle = page.getByTestId("block-reads-outside-working-dirs");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(() => lastPatch).toEqual({ blockReadsOutsideWorkingDirectories: true });

    // Visible in context: the toggle sits above the allow/ask/deny rule
    // columns, under the scope selector — full permissions-page chrome.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "block-reads-outside-working-dirs.png"),
      fullPage: false,
    });

    await toggle.uncheck();
    await expect.poll(() => lastPatch).toEqual({ blockReadsOutsideWorkingDirectories: false });
  });
});
