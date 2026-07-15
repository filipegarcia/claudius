/**
 * CC 2.1.210 — "Added a startup warning for `Write(path)`,
 * `NotebookEdit(path)`, and `Glob(path)` permission rules — use
 * `Edit(path)` or `Read(path)` instead."
 *
 * Claudius has no CLI startup phase to hook this into, so it's surfaced
 * inline on `/permissions` — both as the user types a rule matching one of
 * the three unsupported path-scoped forms, and as a warning icon next to
 * any already-saved rule that matches. The rule still saves either way
 * (Claude Code's own behavior is a *warning*, not a rejection).
 *
 * The GET/POST to `/api/settings/permissions` are mocked so this spec
 * never touches the real dev fixture's settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.210/permission-rule-warning.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.210");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("Unsupported path-scoped permission rule warning (CC 2.1.210)", () => {
  test.beforeEach(async ({ page }) => {
    // Project scope starts with one pre-existing rule that already matches
    // the flagged pattern, so the "already-saved rule" warning path is
    // exercised without requiring a round-trip through the add form first.
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: EMPTY_RULES,
            project: { allow: ["Write(./src/**)"], ask: [], deny: [] },
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

  test("warns on an existing saved rule and on a freshly-typed one", async ({ page }) => {
    // ── 1. Already-saved `Write(./src/**)` shows the warning icon ────────
    const savedIcon = page.getByTestId("permission-rule-warning-icon");
    await expect(savedIcon).toBeVisible({ timeout: 15_000 });
    await expect(savedIcon).toHaveAttribute("title", /Edit\(path\)/);

    // ── 2. Typing another unsupported form shows the inline warning ──────
    // The Allow column's input is the first "add rule" box on the page.
    const draftInput = page.getByPlaceholder("add rule").first();
    await draftInput.fill("Glob(./docs/**)");
    const warning = page.getByTestId("permission-rule-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Glob(path)");
    await expect(warning).toContainText("Read(path)");

    // A supported form shows no warning.
    await draftInput.fill("Read(./docs/**)");
    await expect(warning).toHaveCount(0);

    await draftInput.fill("Glob(./docs/**)");
    await expect(warning).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "permission-rule-warning.png"),
      fullPage: false,
    });
  });
});
