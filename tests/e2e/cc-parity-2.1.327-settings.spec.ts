/**
 * CC 2.1.327 parity on /settings (what /config opens).
 *
 * (a) A save that didn't reach disk used to do nothing: `PUT
 *     /api/settings/full` threw a bare 500 and `onSave` ignored the `false`.
 *     The route now returns a message naming the file (same
 *     `settingsSaveFailure` as /permissions, CC 2.1.326) and the page shows
 *     it in a red strip while the draft stays dirty.
 *
 * `/api/settings/full` is mocked so the spec never touches a real
 * settings.json.
 *
 * Screenshot targets: docs/cc-parity/2.1.327/settings-save-failed.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const CWD = "/Users/me/project";
const PATHS = {
  user: "/Users/me/.claude/settings.json",
  project: `${CWD}/.claude/settings.json`,
  local: `${CWD}/.claude/settings.local.json`,
} as const;

type Scopes = Partial<Record<keyof typeof PATHS, Record<string, unknown>>>;

async function mockSettings(page: Page, scopes: Scopes, onPut?: (route: Route) => Promise<void>): Promise<void> {
  await page.route("**/api/settings/full**", async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: CWD,
          scopes: (["user", "project", "local"] as const).map((scope) => ({
            scope,
            path: PATHS[scope],
            settings: scopes[scope] ?? {},
          })),
        }),
      });
    }
    if (method === "PUT" && onPut) return onPut(route);
    return route.fallback();
  });
}

test.describe("/settings save failure names the file (CC 2.1.327)", () => {
  test.beforeEach(async ({ page }) => {
    await activateClaudiusWorkspace(page);
  });

  test("a save that couldn't be written shows a red strip and keeps the draft", async ({ page }) => {
    const message = `Not saved: couldn't write ${PATHS.user} — permission denied (EACCES).`;
    let puts = 0;
    await mockSettings(page, { user: { model: "sonnet" } }, async (route) => {
      puts += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: message }) });
    });

    await page.goto("/settings");
    const model = page.getByLabel("Model", { exact: true });
    await expect(model).toHaveValue("sonnet", { timeout: 15_000 });

    await model.fill("opus");
    const save = page.getByRole("button", { name: /^Save$/ });
    await save.click();

    const strip = page.getByTestId("settings-save-error");
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toHaveText(message);
    await expect(strip).toContainText(PATHS.user);
    expect(puts).toBe(1);

    // The draft is kept and still dirty, so Save can be retried.
    await page.waitForTimeout(300);
    await expect(model).toHaveValue("opus");
    await expect(save).toBeEnabled();
    await expect(strip).toBeVisible();

    // Frame the kept edit together with the strip (which sits outside the
    // scroll area, under the header).
    await page.getByRole("heading", { name: "Model & UI" }).evaluate((el) => {
      const box = el.closest(".overflow-y-auto");
      if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 24;
    });
    await page.screenshot({ path: resolve(SHOTS_DIR, "settings-save-failed.png"), fullPage: false });
  });
});

test.describe("Auto mode save failure stays on screen (CC 2.1.327)", () => {
  test("the error names the file and survives the rollback refetch", async ({ page }) => {
    const message = `Not saved: couldn't write ${PATHS.user} — permission denied (EACCES).`;
    let gets = 0;
    let failNext = true;
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const empty = { allow: [], ask: [], deny: [] };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: empty, project: empty, local: empty }),
      });
    });
    await page.route("**/api/settings/auto-mode**", async (route: Route) => {
      const method = route.request().method();
      if (method === "GET") {
        gets += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ autoMode: {} }) });
      }
      if (method === "POST") {
        if (failNext) {
          failNext = false;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: message }) });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, autoMode: { classifyAllShell: true } }),
        });
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
    const tab = page.getByTestId("permissions-tab-auto-mode");
    await expect(async () => {
      await page.getByRole("radio", { name: "Account" }).click();
      await expect(tab).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await tab.click();

    const toggle = page.getByTestId("auto-mode-classify-all-shell");
    await expect(toggle).not.toBeChecked();
    const getsBefore = gets;
    await toggle.check();

    const error = page.getByTestId("auto-mode-save-error");
    await expect(error).toHaveText(message);
    // Rolled back by the refetch, and the message outlived it.
    await expect.poll(() => gets).toBeGreaterThan(getsBefore);
    await expect(toggle).not.toBeChecked();
    await page.waitForTimeout(300);
    await expect(error).toBeVisible();

    // The next save that lands clears it.
    await toggle.check();
    await expect(error).toHaveCount(0);
  });
});
