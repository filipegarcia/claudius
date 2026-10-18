/**
 * CC 2.1.302 — "[Cloud sessions] Improved the error shown when a cloud session
 * fails to start: it now says 'Connection lost' or 'Server error' instead of
 * 'Something went wrong'".
 *
 * Claudius analog: the chat's error banner after `POST /api/sessions` fails.
 * A network failure used to print the browser's raw TypeError ("Failed to
 * fetch"), and a server crash read like any other failure. Now: "connection
 * lost — couldn't reach Claudius" vs "server error (5xx) — <detail>".
 *
 * Screenshot target: docs/cc-parity/2.1.302/session-start-connection-lost.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.302");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function mockFailingCreate(page: Page, fail: (route: Route) => Promise<void>): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return fail(route);
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Session start errors (CC 2.1.302)", () => {
  test("an unreachable server reads 'connection lost', not 'Failed to fetch'", async ({ page }) => {
    await mockFailingCreate(page, (route) => route.abort("failed"));
    await page.goto("/");

    const banner = page.getByTestId("session-error").first();
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText("create session failed: connection lost — couldn't reach Claudius");
    await expect(page.getByTestId("session-error").filter({ hasText: /Failed to fetch|Load failed/ })).toHaveCount(0);

    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "session-start-connection-lost.png"), fullPage: false });
  });

  test("a 5xx reads 'server error' and keeps the route's detail", async ({ page }) => {
    await mockFailingCreate(page, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "spawn ENOENT", name: "Error" }),
      }),
    );
    await page.goto("/");

    const banner = page.getByTestId("session-error").first();
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText("create session failed: server error (500) — Error: spawn ENOENT");
  });
});
