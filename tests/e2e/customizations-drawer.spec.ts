import { test, expect, type Page } from "@playwright/test";

/**
 * Drawer behaviour, in isolation from the real customization bootstrap.
 *
 * Creating a real customization triggers a ~1.3 GB mirror copy and takes
 * seconds — fine for a feature smoke, far too slow for a UI spec that needs
 * predictable counts. We instead intercept `GET /api/workspaces` and inject
 * synthetic project + customization rows. The drawer reads exclusively from
 * that list, so it doesn't notice the difference.
 *
 * `/select` is left to the real handler: the test doesn't verify what
 * happens AFTER selection (the page reloads — workspace-cwd-binding.spec
 * already covers that). It only verifies the drawer's open/close/click
 * affordances.
 */

const FIXTURE_WORKSPACES = [
  {
    id: "wks_fixture_project",
    name: "fixture-project",
    rootPath: "/tmp/fixture-project",
    icon: { kind: "letter" as const, letter: "F", color: "#5588dd" },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    defaults: {},
  },
  {
    id: "wks_fixture_cust_a",
    name: "Customize · Fixture Custom A",
    rootPath: "/tmp/cust-a",
    icon: { kind: "letter" as const, letter: "A", color: "#9d6cdd" },
    createdAt: 1_700_000_001_000,
    updatedAt: 1_700_000_001_000,
    lastOpenedAt: 1_700_000_010_000,
    kind: "customization" as const,
    defaults: {},
  },
  {
    id: "wks_fixture_cust_b",
    name: "Customize · Fixture Custom B",
    rootPath: "/tmp/cust-b",
    icon: { kind: "letter" as const, letter: "B", color: "#2e9d8f" },
    createdAt: 1_700_000_002_000,
    updatedAt: 1_700_000_002_000,
    lastOpenedAt: 1_700_000_005_000,
    kind: "customization" as const,
    defaults: {},
  },
];

async function mountFixtureWorkspaces(page: Page): Promise<void> {
  // Match both `/api/workspaces` and `/api/workspaces?...` — the production
  // route is parameterless, but be defensive.
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaces: FIXTURE_WORKSPACES }),
    });
  });
}

test.describe("CustomizationsDrawer", () => {
  test.beforeEach(async ({ page }) => {
    await mountFixtureWorkspaces(page);
  });

  test("count badge appears for inactive customizations", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    // Drawer trigger: the only button inside the rail with the "Customizations"
    // suffix in its title attribute.
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await expect(drawerBtn).toBeVisible();
    // 2 customizations → badge shows "2".
    await expect(drawerBtn).toContainText("2");
  });

  test("opens popover on click, closes on Escape", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();

    const heading = page.getByText("Customizations", { exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("button", { name: /Fixture Custom A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fixture Custom B/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Manage all/ })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(heading).toBeHidden();
  });

  test("closes when clicking outside the popover", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();

    const heading = page.getByText("Customizations", { exact: true });
    await expect(heading).toBeVisible();

    // The popover spans roughly x:68-324 from the rail's right edge; clicking
    // at viewport-absolute (1000, 600) is well outside it.
    await page.mouse.click(1000, 600);
    await expect(heading).toBeHidden();
  });

  test("'Manage all' navigates to /customize and closes the popover", async ({ page }) => {
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();

    await page.getByRole("link", { name: /Manage all/ }).click();
    await expect(page).toHaveURL(/\/customize$/);
  });

  test("clicking a row fires /select for that workspace", async ({ page }) => {
    await page.goto("/");

    // Watch for the select request. The hook then triggers window.location.reload;
    // we don't wait for the reload — just verify the request was made for the
    // right workspace id.
    const selectReq = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/workspaces/wks_fixture_cust_a/select") &&
        req.method() === "POST",
      { timeout: 10_000 },
    );

    // Stub the /select endpoint so the fixture-only workspace id doesn't 404
    // out the assertion; the request itself is what we're measuring.
    await page.route("**/api/workspaces/wks_fixture_cust_a/select", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    await drawerBtn.click();
    await page.getByRole("button", { name: /Fixture Custom A/ }).click();

    await selectReq;
  });

  test("shows empty state when there are no customizations", async ({ page }) => {
    await page.unroute("**/api/workspaces");
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspaces: [FIXTURE_WORKSPACES[0]], // project only, no customizations
        }),
      });
    });
    await page.goto("/");
    const switcher = page.locator('[data-pane-name="workspace-switcher"]');
    const drawerBtn = switcher.locator('button[title*="ustomization"]').first();
    // The trigger title flips to "Customizations — click to manage" when
    // the list is empty.
    await expect(drawerBtn).toHaveAttribute("title", /click to manage/);
    // No badge — count is 0.
    await expect(drawerBtn).not.toContainText(/^\d+$/);

    await drawerBtn.click();
    await expect(page.getByText(/don't have any customizations yet/i)).toBeVisible();
  });
});
