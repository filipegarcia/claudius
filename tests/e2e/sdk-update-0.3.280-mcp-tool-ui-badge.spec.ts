/**
 * SDK 0.3.280 — added `_meta` to each entry in `McpServerStatus.tools[]`,
 * carrying a tool's MCP Apps (SEP-1865) `ui` metadata (a `ui.resourceUri` of
 * scheme `ui://`, or the deprecated flat `ui/resourceUri`) so a host can
 * find and eventually render the tool's own UI resource.
 *
 * Reading and rendering the resource itself (`readMcpResource()`) is alpha,
 * gated behind the `mcp_read_resource_v1` CLI capability, and returns
 * untrusted third-party HTML that needs a sandboxing design of its own — out
 * of scope here. This release only surfaces *presence*: a small "UI" chip
 * next to any tool whose `_meta` declares a `ui://` resource, in the
 * per-server tool list on `/mcp`.
 *
 * `app/api/mcp/route.ts` already forwards `session.mcpServerStatus()`'s raw
 * data untouched, so `_meta` reaches the client for free; this release adds
 * the field to Claudius's hand-typed `LiveStatus` shape (`lib/client/useMcp.ts`)
 * and renders the chip in `app/[workspaceId]/mcp/page.tsx`.
 *
 * This spec drives the real `/mcp` page (SideNav + page chrome visible),
 * mocks `GET /api/mcp` to return one server with a tool that declares a
 * `ui://` resource and one plain tool with no `_meta`, expands the server
 * row, and asserts only the UI-resource tool gets the chip.
 *
 * Screenshot target: docs/sdk-updates/0.3.280/mcp-tool-ui-badge.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.280");
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
            name: "widgets",
            config: { command: "node", args: ["widgets-server.js"] },
          },
        ],
        status: [
          {
            name: "widgets",
            status: "connected",
            source: "project",
            tools: [
              {
                name: "render_dashboard",
                description: "Renders an interactive dashboard widget.",
                _meta: { ui: { resourceUri: "ui://widgets/dashboard", visibility: ["app"] } },
              },
              {
                name: "list_widgets",
                description: "Lists available widgets as plain text.",
              },
            ],
          },
        ],
        statusError: null,
      }),
    });
  });
});

test.describe("SDK 0.3.280 — MCP tool UI-resource badge", () => {
  test("a tool with a ui:// resource shows a UI chip; a plain tool doesn't", async ({ page }) => {
    await page.goto("/mcp");

    const serverToggle = page.getByRole("button", { name: /widgets/ });
    await expect(serverToggle).toBeVisible({ timeout: 15_000 });
    await serverToggle.click();

    const uiBadge = page.getByTestId("mcp-tool-ui-badge-render_dashboard");
    await expect(uiBadge).toBeVisible();
    await expect(uiBadge).toHaveText(/UI/);
    await expect(uiBadge).toHaveAttribute("title", /ui:\/\/widgets\/dashboard/);

    // The plain tool (no `_meta`) must not get the chip.
    await expect(page.getByTestId("mcp-tool-ui-badge-list_widgets")).toHaveCount(0);

    await uiBadge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "mcp-tool-ui-badge.png"),
      fullPage: false,
    });
  });
});
