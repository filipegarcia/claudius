/**
 * CC 2.1.332 — "Improved `/permissions` to refuse a rule that would be
 * skipped at the next start, such as `rm -rf` with no tool name, and to show
 * the reason".
 *
 * Typing `rm -rf` into the Deny column used to save it to settings.json; the
 * engine then dropped it at start ("Invalid permission rule … was skipped"),
 * so the user believed a deny rule protected them when it didn't. The column
 * now refuses it with the engine's reason and keeps the draft to fix; a rule
 * already in the file that the engine skips gets a red icon.
 *
 * GET/POST `/api/settings/permissions` are mocked, so no settings file is
 * touched.
 *
 * Screenshot target: docs/cc-parity/2.1.332/permission-rule-refused.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test("/permissions refuses a rule the engine would skip and says why", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/api/settings/permissions**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: EMPTY_RULES,
          // A hand-edited rule the engine drops at start.
          project: { allow: [], ask: [], deny: ["curl"] },
          local: EMPTY_RULES,
        }),
      });
    }
    if (req.method() === "POST") {
      posts.push(req.postDataJSON() as Record<string, unknown>);
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

  // The existing bad rule is flagged with the engine's reason.
  const skipped = page.getByTestId("permission-rule-skipped-icon");
  await expect(skipped).toHaveCount(1, { timeout: 15_000 });
  await expect(skipped).toHaveAttribute(
    "title",
    'Claude Code skips this rule at start: Tool names must start with uppercase. Use "Curl"',
  );

  // Columns render Allow, Ask, Deny — the third box is Deny.
  const deny = page.getByPlaceholder("add rule").nth(2);
  await deny.fill("rm -rf");
  await deny.press("Enter");

  const refused = page.getByTestId("permission-rule-refused");
  await expect(refused).toHaveText(
    'Not added — Claude Code would skip this rule at the next start: Tool names must start with uppercase. Use "Rm -rf".',
  );
  // Nothing was sent, and the draft is kept so it can be fixed.
  expect(posts).toHaveLength(0);
  await expect(deny).toHaveValue("rm -rf");
  await expect(deny).toHaveAttribute("aria-invalid", "true");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "permission-rule-refused.png"), fullPage: false });

  // A malformed rule's inline lint no longer promises it will save.
  await deny.fill("Bash(ls) x");
  await expect(refused).toHaveCount(0);
  await expect(page.getByTestId("permission-rule-trailing-garbage-warning")).toContainText(
    "Claude Code would skip it at the next start, so it can't be added.",
  );

  // Typing the rule the way the engine reads it saves it.
  await deny.fill("Bash(rm -rf *)");
  await deny.press("Enter");
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ scope: "project", ruleDelta: { kind: "deny", add: ["Bash(rm -rf *)"] } });
  await expect(deny).toHaveValue("");
  await expect(refused).toHaveCount(0);
});
