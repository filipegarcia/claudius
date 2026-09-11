/**
 * SDK 0.3.268 — `Query.reloadPlugins({ holdOnCacheImpact })` and the
 * `reload_plugins` control request's `hold_on_cache_impact` field, neither
 * mentioned in the prose changelog (found by diffing `sdk.d.ts`).
 *
 * `Session.reloadPlugins()` (lib/server/session.ts) now defaults to
 * `holdOnCacheImpact: true` — the same check the interactive CLI's
 * `/reload-plugins` makes before it asks for `--force`. When applying would
 * invalidate the session's prompt cache, the reload is NOT applied; the
 * response carries `held: true` plus a `cache_impact` summary
 * (`lib/shared/reload-plugins.ts` turns that into toast copy). The chat
 * command grew a `force` argument (`/reload-plugins force`) that re-sends
 * with the hold lifted (`app/api/plugins/reload/route.ts`'s `?force=1`).
 *
 * This spec drives both paths through the real chat composer against a
 * mocked `/api/plugins/reload` route. No real SDK required.
 *
 * Screenshot target: docs/sdk-updates/0.3.268/reload-plugins-held-toast.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.268");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "cccccccc-1111-2222-3333-444444443268";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-init-3268", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(PRELUDE),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  await page.route(`**/api/plugins/reload*`, async (route: Route) => {
    const url = new URL(route.request().url());
    const forced = url.searchParams.get("force") === "1";
    if (forced) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plugins: [], mcpServers: [], error_count: 0, held: false }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plugins: [],
        mcpServers: [],
        error_count: 0,
        held: true,
        cache_impact: {
          mcp_servers_added: ["docs-server"],
          mcp_servers_removed: [],
          lsp_tool_change: null,
        },
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDK 0.3.268 — reloadPlugins holdOnCacheImpact", () => {
  test("'/reload-plugins' holds and summarizes the impact; 'force' applies it", async ({ page }) => {
    await mockChatBackend(page);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const heldReq = page.waitForRequest(
      (req) => req.url().includes("/api/plugins/reload") && req.method() === "POST",
    );
    await composer.fill("/reload-plugins");
    await page.getByTestId("prompt-send").click();
    const req = await heldReq;
    expect(new URL(req.url()).searchParams.get("force")).toBeNull();

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("Reload held");
    await expect(toast).toContainText("+1 MCP server");
    await expect(toast).toContainText("/reload-plugins force");

    // Capture the held-reload toast in context — chat surface, composer,
    // and the toast itself all visible together.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "reload-plugins-held-toast.png"),
      fullPage: false,
    });

    const forcedReq = page.waitForRequest(
      (req) => req.url().includes("/api/plugins/reload") && req.method() === "POST",
    );
    await composer.fill("/reload-plugins force");
    await page.getByTestId("prompt-send").click();
    const forced = await forcedReq;
    expect(new URL(forced.url()).searchParams.get("force")).toBe("1");

    await expect(toast).toContainText("Plugins reloaded");
  });
});
