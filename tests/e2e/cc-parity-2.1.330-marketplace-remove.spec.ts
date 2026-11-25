/**
 * CC 2.1.330 — "Fixed … a double click on Remove or Delete removing a memory,
 * MCP server or plugin marketplace, without confirmation".
 *
 * On /plugins → Marketplaces, the X next to an extra marketplace removed it
 * at once, and the X on an allowed/blocked policy entry removed by index, so
 * a double click sent two removals and the second one took out the entry
 * that had shifted into that index. Both now ask first, the X is disabled
 * while its request is in flight, and a policy removal carries the entry it
 * means (the server refuses a stale one with 409 and the page says so).
 *
 * `/api/plugins` is mocked, so no settings file is touched.
 *
 * Screenshot target: docs/cc-parity/2.1.330/marketplace-remove.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SHOTS_DIR, { recursive: true });

const STALE = "That entry is no longer in this list as shown, so nothing was removed. The list has been refreshed.";

const view = (kind: string, label: string) => ({ kind, label, headerKeys: [], hasHeadersHelper: false });

function scope(name: string, path: string, extra: unknown[] = [], strict: unknown[] = []) {
  return {
    scope: name,
    path,
    enabledPlugins: {},
    extraKnownMarketplaces: extra,
    strictKnownMarketplaces: strict,
    blockedMarketplaces: [],
    legacyExtra: false,
    pluginConfigs: {},
  };
}

async function mockBackend(
  page: Page,
  posts: Array<Record<string, unknown>>,
  answer: (body: Record<string, unknown>) => { status: number; body: unknown },
): Promise<void> {
  let strict = [view("github", "acme/a"), view("github", "acme/b"), view("url", "https://example.com/m.json")];
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        posts.push(body);
        const a = answer(body);
        // Slow enough that a second click lands while the first is in flight.
        await new Promise((r) => setTimeout(r, 400));
        if (a.status === 200 && body.op === "remove-policy") strict = strict.filter((_, i) => i !== body.index);
        return route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            scope(
              "user",
              "/home/user/.claude/settings.json",
              [{ name: "acme", ...view("github", "acme/plugins") }],
              strict,
            ),
            scope("project", "/home/user/acme/.claude/settings.json"),
            scope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [],
          installedError: null,
          pluginErrors: [],
        }),
      });
    },
  );
  await page.route("**/api/plugins/available", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) }),
  );
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("marketplace Remove asks first, and a double click removes one policy entry", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockBackend(page, posts, () => ({ status: 200, body: { ok: true } }));
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });

  await page.goto("/plugins");
  const extraX = page.getByTestId("marketplace-extra-remove-acme");
  await expect(extraX).toBeVisible({ timeout: 15_000 });

  // Cancelling the confirmation sends nothing.
  await extraX.click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toBe('Remove marketplace "acme" (acme/plugins) from settings?');
  expect(posts).toHaveLength(0);

  // A double click on a policy X: one confirmation, one removal, aimed at
  // the entry by value.
  accept = true;
  await page.getByTestId("marketplace-policy-strict-remove-1").dblclick();
  await expect.poll(() => posts.length).toBe(1);
  expect(dialogs[1]).toBe(
    'Remove the github source "acme/b" from Allowed sources (strictKnownMarketplaces)?',
  );
  expect(posts[0]).toMatchObject({
    kind: "marketplaces",
    op: "remove-policy",
    list: "strict",
    index: 1,
    expected: { kind: "github", label: "acme/b" },
  });
  const strict = page.getByTestId("marketplace-policy-strict");
  await expect(strict.locator("li")).toHaveCount(2);
  await expect(strict).not.toContainText("acme/b");
  await expect(strict).toContainText("https://example.com/m.json");
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(1);
  expect(dialogs).toHaveLength(2);
});

test("a policy Remove the server finds stale says nothing was removed", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockBackend(page, posts, () => ({ status: 409, body: { error: STALE } }));
  page.on("dialog", (d) => void d.accept());

  await page.goto("/plugins");
  const x = page.getByTestId("marketplace-policy-strict-remove-0");
  await expect(x).toBeVisible({ timeout: 15_000 });
  await x.click();
  await expect(page.getByTestId("marketplace-policy-error")).toHaveText(STALE);
  expect(posts).toHaveLength(1);
  await expect(page.getByTestId("marketplace-policy-strict").locator("li")).toHaveCount(3);

  await page.getByTestId("marketplace-policy-strict").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "marketplace-remove.png"), fullPage: false });
});
