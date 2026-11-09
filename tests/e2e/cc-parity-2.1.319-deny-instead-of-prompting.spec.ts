/**
 * CC 2.1.319 parity — "Added `permissions.denyInsteadOfPrompting` setting: a
 * tool call that would wait on a permission prompt is denied and the turn
 * continues". The engine reads it only from user / `--settings` / managed
 * sources, so /permissions offers it on the Account scope only, next to the
 * other permission flags.
 *
 * GET/POST to `/api/settings/permissions` are mocked so the spec never
 * touches the real settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.319/deny-instead-of-prompting.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.319");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = {
  allow: [],
  ask: [],
  deny: [],
  blockReadsOutsideWorkingDirectories: false,
  blockWritesOutsideWorkingDirectories: false,
};

test("Account scope offers 'Deny instead of prompting'; Workspace scope doesn't", async ({ page }) => {
  const posts: Array<{ scope?: string; patch?: unknown }> = [];
  await page.route("**/api/settings/permissions**", async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: EMPTY_RULES, project: EMPTY_RULES, local: EMPTY_RULES }),
      });
    }
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON() as { scope?: string; patch?: unknown });
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

  // Workspace scope: the engine ignores the flag in project/local settings.
  await expect(page.getByTestId("block-writes-outside-working-dirs")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("deny-instead-of-prompting")).toHaveCount(0);

  await page.getByRole("radio", { name: "Account" }).click();
  const toggle = page.getByTestId("deny-instead-of-prompting");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  const label = page.locator("label", { has: toggle });
  await expect(label).toContainText("Deny instead of prompting");
  await expect(label).toContainText("~/.claude/settings.json");

  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect.poll(() => posts.at(-1)).toEqual({ scope: "user", patch: { denyInsteadOfPrompting: true } });

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "deny-instead-of-prompting.png"), fullPage: false });

  await toggle.uncheck();
  await expect.poll(() => posts.at(-1)).toEqual({ scope: "user", patch: { denyInsteadOfPrompting: false } });
});
