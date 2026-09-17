/**
 * SDK 0.3.274 — added `source` to `McpServerStatus` (and to the `mcp_servers[]`
 * entries on `system/init`): where an MCP server's definition came from —
 * `"sdk"` for one of the in-process servers this host registered itself, or
 * the config scope (`project`, `user`, `plugin`, …) for one that came from
 * configuration. The same `McpServerProvenance` shape was also added to
 * `canUseTool` options and every tool-use hook input, so a host can key
 * trust decisions on `source` rather than on the server name or the
 * `mcp__`-prefixed tool name (an untrusted, attacker-influenceable string
 * for non-"sdk" sources).
 *
 * `app/api/mcp/route.ts` already forwards `session.mcpServerStatus()`'s raw
 * data untouched, so the new field reached the client for free; this
 * release adds it to Claudius's own hand-typed `LiveStatus` shape
 * (`lib/client/useMcp.ts`) and renders it as a badge next to each server's
 * scope label on the `/mcp` status page (`app/[workspaceId]/mcp/page.tsx`).
 *
 * This spec drives the real `/mcp` page (SideNav + page chrome visible),
 * mocks `GET /api/mcp` to return one `source: "sdk"` server and one
 * `source: "project"` server, and asserts both badges render with visibly
 * different styling (the "sdk" badge in the accent color used elsewhere for
 * Claudius's own in-process plumbing, the configured-source badge in the
 * neutral tone used for everything else) — a reviewer should be able to
 * tell at a glance which servers Claudius itself registered.
 *
 * Screenshot target: docs/sdk-updates/0.3.274/mcp-source-badge.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.274");
mkdirSync(SHOTS_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);

  await page.route("**/api/mcp?*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: [
          {
            scope: "project",
            name: "claudius_goal",
            config: { command: "node", args: ["goal-server.js"] },
          },
          {
            scope: "project",
            name: "linear",
            config: { type: "http", url: "https://mcp.linear.app/mcp" },
          },
        ],
        status: [
          {
            name: "claudius_goal",
            status: "connected",
            source: "sdk",
            tools: [{ name: "report_goal_achieved" }],
          },
          {
            name: "linear",
            status: "connected",
            source: "project",
            tools: [{ name: "search_issues" }],
          },
        ],
        statusError: null,
      }),
    });
  });
});

test.describe("SDK 0.3.274 — MCP server source badge", () => {
  test("an SDK-registered server and a configured server show distinct source badges", async ({
    page,
  }) => {
    await page.goto("/mcp");

    const sdkBadge = page.getByTestId("mcp-source-badge-claudius_goal");
    await expect(sdkBadge).toBeVisible({ timeout: 15_000 });
    await expect(sdkBadge).toHaveText("sdk");

    const projectBadge = page.getByTestId("mcp-source-badge-linear");
    await expect(projectBadge).toBeVisible();
    await expect(projectBadge).toHaveText("project");

    // The two badges must render with visibly different styling — the
    // sdk-registered server should read as visually distinct from a
    // server sourced from configuration.
    const sdkClass = await sdkBadge.getAttribute("class");
    const projectClass = await projectBadge.getAttribute("class");
    expect(sdkClass).not.toEqual(projectClass);
    expect(sdkClass).toContain("accent");

    await page.locator('[data-testid="mcp-source-badge-linear"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "mcp-source-badge.png"),
      fullPage: false,
    });
  });
});
