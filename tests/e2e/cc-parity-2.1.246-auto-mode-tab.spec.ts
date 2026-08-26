/**
 * CC 2.1.246 — "Added an Auto mode tab to /permissions for viewing and
 * editing auto mode classifier rules."
 *
 * The classifier itself is engine-side (arrives automatically via the SDK
 * updater); this spec covers the product-side piece Claudius reimplements —
 * a 4th tab on `/permissions`, visible only in Account (user) scope, that
 * reads/writes the `autoMode.{environment,allow,soft_deny,hard_deny}` block
 * of `~/.claude/settings.json` via `/api/settings/auto-mode`.
 *
 * `/api/settings/permissions`, `/api/settings/auto-mode`, and `/api/sessions`
 * are all mocked so this spec never touches the real dev fixture's
 * settings.json.
 *
 * Screenshot target: docs/cc-parity/2.1.246/auto-mode-tab.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.246");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("Auto mode tab on /permissions (CC 2.1.246)", () => {
  let lastAutoModePatch: unknown = null;
  let autoModeConfig: Record<string, string[]> = {
    environment: ["$defaults", "Source control: github.example.com/acme-corp"],
    allow: ["$defaults"],
    soft_deny: [],
    hard_deny: [],
  };

  test.beforeEach(async ({ page }) => {
    lastAutoModePatch = null;
    autoModeConfig = {
      environment: ["$defaults", "Source control: github.example.com/acme-corp"],
      allow: ["$defaults"],
      soft_deny: [],
      hard_deny: [],
    };

    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: EMPTY_RULES, project: EMPTY_RULES, local: EMPTY_RULES }),
        });
      }
      return route.fallback();
    });

    await page.route("**/api/settings/auto-mode**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ autoMode: autoModeConfig }),
        });
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { patch: Record<string, string[]> };
        lastAutoModePatch = body.patch;
        autoModeConfig = { ...autoModeConfig, ...body.patch };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, autoMode: autoModeConfig }),
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
  });

  test("appears only in Account scope, loads the classifier config, and saves edits", async ({
    page,
  }) => {
    // ── 1. Workspace scope (the page's default): no Auto mode tab ────────
    await expect(page.getByTestId("permissions-tab-auto-mode")).toHaveCount(0);

    // ── 2. Switch to Account scope — the tab strip appears ───────────────
    // `toPass` re-clicks if the tab hasn't shown up yet: this page's first
    // paint can occasionally win a race against React attaching the radio's
    // click handler (the DOM looks interactive before hydration finishes),
    // which swallows a single click with no visible sign of failure. Retrying
    // the click is self-healing against that race without weakening the
    // assertion itself.
    const autoModeTabButton = page.getByTestId("permissions-tab-auto-mode");
    await expect(async () => {
      await page.getByRole("radio", { name: "Account" }).click();
      await expect(autoModeTabButton).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await autoModeTabButton.click();

    // ── 3. Loaded config renders in the Environment section ──────────────
    const envBox = page.getByTestId("auto-mode-environment");
    await expect(envBox).toBeVisible();
    await expect(envBox).toHaveValue("Source control: github.example.com/acme-corp");
    await expect(page.getByTestId("auto-mode-environment-keep-defaults")).toBeChecked();

    // ── 4. Editing + blurring the Allow section saves the patch ──────────
    const allowBox = page.getByTestId("auto-mode-allow");
    await expect(page.getByTestId("auto-mode-allow-keep-defaults")).toBeChecked();
    await allowBox.fill("Deploying to the staging namespace is allowed");
    await page.getByTestId("auto-mode-soft-deny").click(); // blur via clicking elsewhere

    await expect.poll(() => lastAutoModePatch).toEqual({
      allow: ["$defaults", "Deploying to the staging namespace is allowed"],
    });

    // ── 5. Unchecking "keep built-in rules" drops the $defaults sentinel ─
    await page.getByTestId("auto-mode-soft-deny-keep-defaults").check();
    await expect.poll(() => lastAutoModePatch).toEqual({ soft_deny: ["$defaults"] });
    await page.getByTestId("auto-mode-soft-deny-keep-defaults").uncheck();
    await expect.poll(() => lastAutoModePatch).toEqual({ soft_deny: [] });

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "auto-mode-tab.png"),
      fullPage: false,
    });
  });
});
