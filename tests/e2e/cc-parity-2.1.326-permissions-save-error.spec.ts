/**
 * CC 2.1.326 — "Fixed rules added in /permissions or at a main-conversation
 * tool prompt, and /add-dir folders, looking saved when the settings file
 * couldn't be written; the terminal now warns and names it".
 *
 * Claudius's `/api/settings/permissions` used to 500 with no body when the
 * settings file couldn't be read or written. `usePermissions` showed
 * `save failed: 500` for a moment, then the rollback refetch cleared it, so
 * the new rule simply vanished. The route now returns a message naming the
 * file (unit-tested in `tests/unit/cc-parity-2.1.326-settings-save-failed.test.ts`),
 * and the page keeps it on screen in a banner.
 *
 * GET/POST are mocked so the spec never touches a real settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.326/permissions-save-error.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };
const FILE = "/Users/me/project/.claude/settings.json";
const MESSAGE = `Not saved: couldn't write ${FILE} — permission denied (EACCES).`;

test.describe("Permissions save failure names the file (CC 2.1.326)", () => {
  test("a rule that couldn't be written is rolled back and the banner names the file", async ({ page }) => {
    let gets = 0;
    let failNext = true;
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        gets += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: EMPTY_RULES, project: { allow: ["Bash(npm test)"], ask: [], deny: [] }, local: EMPTY_RULES }),
        });
      }
      if (route.request().method() === "POST") {
        if (failNext) {
          failNext = false;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: MESSAGE }) });
        }
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
    await expect(page.getByText("Bash(npm test)").first()).toBeVisible({ timeout: 15_000 });

    const draft = page.getByPlaceholder("add rule").first();
    await draft.fill("Bash(git status)");
    await draft.press("Enter");

    const banner = page.getByTestId("permissions-save-error");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveText(MESSAGE);
    // The optimistic rule was rolled back by the refetch, and the banner
    // survived that refetch (it used to be cleared by it).
    await expect.poll(() => gets).toBeGreaterThan(1);
    await expect(page.getByText("Bash(git status)")).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(banner).toBeVisible();

    await page.screenshot({ path: resolve(SHOTS_DIR, "permissions-save-error.png"), fullPage: false });

    // The next save that lands clears it.
    await draft.fill("Bash(git status)");
    await draft.press("Enter");
    await expect(banner).toHaveCount(0);
  });
});
