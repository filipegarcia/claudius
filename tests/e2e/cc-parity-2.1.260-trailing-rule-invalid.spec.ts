/**
 * CC 2.1.260 — "Changed permission rules with text after the closing
 * parenthesis (e.g. `Bash(ls) x`), which never matched anything, to be
 * reported as invalid settings instead of being silently ignored."
 *
 * Claudius has no settings-file load phase to reject an invalid entry at,
 * so — matching the existing 2.1.210 (`Write(path)`/`NotebookEdit(path)`/
 * `Glob(path)`) and 2.1.246 (Bash mid-command wildcard) lints — this is
 * surfaced inline on `/permissions`: a warning icon on any already-saved
 * rule that has trailing text after its closing paren, and an inline
 * message as the user types one. The rule still saves either way (same
 * non-blocking treatment as the other two lints).
 *
 * The GET/POST to `/api/settings/permissions` are mocked so this spec
 * never touches the real dev fixture's settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.260/trailing-rule-invalid.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.260");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("Trailing-text-after-paren permission rule warning (CC 2.1.260)", () => {
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
            project: { allow: ["Bash(ls) x"], ask: [], deny: [] },
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
    // ── 1. Already-saved `Bash(ls) x` shows the warning icon ─────────────
    const savedIcon = page.getByTestId("permission-rule-trailing-garbage-warning-icon");
    await expect(savedIcon).toBeVisible({ timeout: 15_000 });
    await expect(savedIcon).toHaveAttribute("title", /never matches anything/);

    // ── 2. Typing another rule with trailing garbage shows the inline warning ──
    const draftInput = page.getByPlaceholder("add rule").first();
    await draftInput.fill("Read(./docs/**) whoops");
    const warning = page.getByTestId("permission-rule-trailing-garbage-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("whoops");
    await expect(warning).toContainText("invalid");

    // A well-formed rule shows no warning.
    await draftInput.fill("Read(./docs/**)");
    await expect(warning).toHaveCount(0);

    await draftInput.fill("Read(./docs/**) whoops");
    await expect(warning).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "trailing-rule-invalid.png"),
      fullPage: false,
    });
  });
});
