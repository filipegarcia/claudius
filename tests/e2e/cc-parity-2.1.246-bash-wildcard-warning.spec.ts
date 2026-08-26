/**
 * CC 2.1.246 — "Added a startup warning for Bash allow rules with a
 * wildcard before the subcommand (e.g. `Bash(git * main)`), since they also
 * match options inserted before the subcommand."
 *
 * Claudius has no CLI startup phase to hook this into, so — mirroring the
 * CC 2.1.210 `Write(path)`/`NotebookEdit(path)`/`Glob(path)` warning already
 * on this page — it's surfaced inline on `/permissions`: a warning icon next
 * to any saved Bash *allow* rule whose wildcard sits before a fixed trailing
 * word, and the same warning as the user types one. The rule still saves
 * either way; this is a warning, not a rejection.
 *
 * The GET/POST to `/api/settings/permissions` are mocked so this spec never
 * touches the real dev fixture's settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.246/bash-wildcard-warning.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.246");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("Bash wildcard-before-subcommand permission rule warning (CC 2.1.246)", () => {
  test.beforeEach(async ({ page }) => {
    // Project scope starts with one pre-existing allow rule that already
    // matches the flagged pattern, so the "already-saved rule" warning path
    // is exercised without requiring a round-trip through the add form.
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: EMPTY_RULES,
            project: { allow: ["Bash(git * main)"], ask: [], deny: [] },
            local: EMPTY_RULES,
          }),
        });
      }
      if (route.request().method() === "POST") {
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

  test("warns on an existing saved Bash allow rule and on a freshly-typed one", async ({ page }) => {
    // ── 1. Already-saved `Bash(git * main)` shows the warning icon ───────
    const savedIcon = page.getByTestId("permission-rule-bash-wildcard-warning-icon");
    await expect(savedIcon).toBeVisible({ timeout: 15_000 });
    await expect(savedIcon).toHaveAttribute("title", /matches options inserted in between/);

    // ── 2. Typing another wildcard-before-subcommand rule warns inline ───
    const draftInput = page.getByPlaceholder("add rule").first();
    await draftInput.fill("Bash(npm * install)");
    const warning = page.getByTestId("permission-rule-bash-wildcard-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("npm * install");

    // A trailing wildcard — the common "anything after this" pattern —
    // shows no warning.
    await draftInput.fill("Bash(npm run *)");
    await expect(warning).toHaveCount(0);

    await draftInput.fill("Bash(npm * install)");
    await expect(warning).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "bash-wildcard-warning.png"),
      fullPage: false,
    });
  });
});
