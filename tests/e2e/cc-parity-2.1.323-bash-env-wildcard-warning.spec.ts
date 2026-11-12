/**
 * CC 2.1.323 — "Added a start-up warning for Bash allow rules with a `*` in a
 * variable's value, such as `Bash(PORT=* npm run dev)`".
 *
 * Claudius has no start-up phase, so — like the four other rule lints on this
 * page (2.1.210, 2.1.246, 2.1.260 ×2) — it's an inline warning on
 * `/permissions`: a chip next to a saved allow rule, and the engine's
 * sentence under the add box as one is typed. The rule still saves.
 *
 * Also covers the 2.1.323 settings-merge fix: adding a rule POSTs a
 * `ruleDelta` (just the added rule), not the page's cached list.
 *
 * The GET/POST to `/api/settings/permissions` are mocked so this spec never
 * touches the dev fixture's settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.323/bash-env-wildcard-warning.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("Bash env-variable wildcard rule warning (CC 2.1.323)", () => {
  test("warns on a saved rule and a typed one; adding sends only the new rule", async ({ page }) => {
    const posts: unknown[] = [];
    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: EMPTY_RULES,
            project: { allow: ["Bash(PORT=* npm run dev)", "Bash(npm test)"], ask: [], deny: [] },
            local: EMPTY_RULES,
          }),
        });
      }
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
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

    // ── 1. The saved `Bash(PORT=* npm run dev)` carries the chip; the plain rule doesn't.
    const savedIcon = page.getByTestId("permission-rule-bash-env-wildcard-warning-icon");
    await expect(savedIcon).toHaveCount(1, { timeout: 15_000 });
    await expect(savedIcon).toHaveAttribute(
      "title",
      "Bash(PORT=* npm run dev) allows any command at the * in its value · use an exact value",
    );

    // ── 2. Typing one shows the engine's sentence, naming the command.
    const draftInput = page.getByPlaceholder("add rule").first();
    await draftInput.fill("Bash(NODE_ENV=* node server.js)");
    const warning = page.getByTestId("permission-rule-bash-env-wildcard-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Bash(NODE_ENV=* node server.js) has a * in a variable's value.");
    await expect(warning).toContainText("approve a different command that has node later in the line");
    await expect(warning).toContainText("The rule will still save as typed.");

    // An exact value — or a * only after the command — doesn't warn.
    await draftInput.fill("Bash(NODE_ENV=production npm run *)");
    await expect(warning).toHaveCount(0);
    await draftInput.fill("Bash(NODE_ENV=* node server.js)");
    await expect(warning).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "bash-env-wildcard-warning.png"), fullPage: false });

    // ── 3. Saving still works, and sends just the delta.
    await draftInput.press("Enter");
    await expect.poll(() => posts.at(-1)).toEqual({
      scope: "project",
      ruleDelta: { kind: "allow", add: ["Bash(NODE_ENV=* node server.js)"] },
    });
    await expect(page.getByTestId("permission-rule-bash-env-wildcard-warning-icon")).toHaveCount(2);
  });
});
