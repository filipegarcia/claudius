/**
 * CC 2.1.284 — "Added `/mcp reconnect all` in the interactive terminal to
 * retry every MCP server that failed to connect or needs authentication at
 * once."
 *
 * Claudius's `/mcp` page (`app/[workspaceId]/mcp/page.tsx`) already has a
 * per-server "Reconnect" button (`useMcp.reconnect(name)`, CC 2.1.193/2.1.268
 * parity) but no bulk action — a user with several stuck servers had to click
 * Reconnect on each row individually. This release adds a "Reconnect all"
 * header button (`useMcp.reconnectAll()`) that fires the existing per-server
 * reconnect call for every server currently `failed` or `needs-auth`, exactly
 * mirroring the CLI's new subcommand. Servers already `connected` or
 * `disabled` are left untouched, and the button itself is hidden entirely
 * when nothing needs it.
 *
 * Screenshot target: docs/cc-parity/2.1.284/mcp-reconnect-all.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.284");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);

  // A session must be "live" for the page to bind sessionId and enable
  // reconnect at all — /api/sessions is polled by the page to find a
  // session whose cwd matches the active workspace (rootPath === process.cwd(),
  // set by activateClaudiusWorkspace above).
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: FAKE_SESSION_ID, cwd: process.cwd() }]),
    });
  });

  await page.route("**/api/mcp?*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: [
          { scope: "user", name: "github", config: { command: "npx", args: ["-y", "server-github"] } },
          { scope: "project", name: "linear", config: { type: "http", url: "https://mcp.linear.app/mcp" } },
          { scope: "user", name: "docs", config: { command: "npx", args: ["-y", "server-docs"] } },
        ],
        status: [
          { name: "github", status: "failed", error: "connection refused" },
          { name: "linear", status: "needs-auth" },
          { name: "docs", status: "connected", tools: [{ name: "search" }] },
        ],
        statusError: null,
      }),
    });
  });
});

test.describe("CC 2.1.284 — /mcp 'Reconnect all' bulk action", () => {
  test("reconnects every failed/needs-auth server, leaves connected servers alone", async ({ page }) => {
    const reconnected: string[] = [];
    await page.route("**/api/mcp/*/reconnect*", async (route: Route) => {
      const url = new URL(route.request().url());
      const name = decodeURIComponent(url.pathname.split("/").slice(-2, -1)[0]);
      reconnected.push(name);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/mcp");

    const button = page.getByTestId("mcp-reconnect-all");
    await expect(button).toBeVisible({ timeout: 15_000 });
    await expect(button).toHaveText(/Reconnect all \(2\)/);

    await button.click();

    await expect(async () => {
      expect(reconnected.sort()).toEqual(["github", "linear"]);
    }).toPass({ timeout: 5_000 });

    // The already-connected server was never touched.
    expect(reconnected).not.toContain("docs");

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "mcp-reconnect-all.png"),
      fullPage: false,
    });
  });

  test("the button is hidden when every server is already connected", async ({ page }) => {
    await page.route("**/api/mcp?*", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: [{ scope: "user", name: "docs", config: { command: "npx", args: ["-y", "server-docs"] } }],
          status: [{ name: "docs", status: "connected", tools: [] }],
          statusError: null,
        }),
      });
    });

    await page.goto("/mcp");
    await expect(page.getByTestId("mcp-status-badge-docs")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("mcp-reconnect-all")).toHaveCount(0);
  });
});
