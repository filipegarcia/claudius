/**
 * CC 2.1.330 — "Fixed `claude mcp remove` giving no way forward for a
 * claude.ai connector: it now says to turn it off in /mcp or remove it on
 * claude.ai".
 *
 * Every /mcp row had a red Remove button. For a claude.ai connector, a
 * plugin's server, or a server outside the files Claudius edits, it asked
 * "Remove … from undefined?" and then silently did nothing (the route 400s
 * on those scopes and the page dropped the result). Those rows now say where
 * the server is managed instead, and a Remove that fails shows why.
 *
 * /api/mcp and /api/sessions are mocked, so no config file is touched.
 *
 * Screenshot target: docs/cc-parity/2.1.330/mcp-remove-hints.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000002330";
const NOT_FOUND = "\"docs\" isn't in the user config any more. Refresh to see the current list.";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
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
    const withSession = new URL(route.request().url()).searchParams.get("sessionId") === FAKE_SESSION_ID;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: [{ scope: "user", name: "docs", config: { command: "npx", args: ["-y", "server-docs"] } }],
        status: withSession
          ? [
              { name: "docs", status: "connected", scope: "user", source: "user" },
              { name: "claude.ai Linear", status: "connected", scope: "claudeai", source: "claudeai" },
              { name: "plugin:github-tools:github", status: "connected", scope: "dynamic", source: "plugin" },
              { name: "notes", status: "connected", scope: "user", source: "user" },
            ]
          : null,
        statusError: null,
      }),
    });
  });
});

test("/mcp only offers Remove for servers in a file Claudius edits, and says why one failed", async ({ page }) => {
  let deletes = 0;
  await page.route("**/api/mcp/*?*", async (route: Route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes += 1;
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: NOT_FOUND }) });
  });

  await page.goto("/mcp");
  await expect(page.getByTestId("mcp-status-badge-claude.ai Linear")).toBeVisible({ timeout: 15_000 });

  // The file-backed server keeps its Remove button.
  await expect(page.getByTestId("mcp-remove-docs")).toBeVisible();

  // A claude.ai connector points at claude.ai.
  await expect(page.getByTestId("mcp-remove-claude.ai Linear")).toHaveCount(0);
  const connector = page.getByTestId("mcp-remove-hint-claude.ai Linear");
  await expect(connector).toHaveText("Remove on claude.ai");
  await expect(connector).toHaveAttribute("href", "https://claude.ai/customize/connectors");
  await expect(connector).toHaveAttribute("title", /Claude Code can't remove/);

  // A plugin's server points at Plugins.
  await expect(page.getByTestId("mcp-remove-plugin:github-tools:github")).toHaveCount(0);
  const plugin = page.getByTestId("mcp-remove-hint-plugin:github-tools:github");
  await expect(plugin).toHaveText("Manage in Plugins");
  await expect(plugin).toHaveAttribute("href", "/plugins");
  await expect(plugin).toHaveAttribute("title", /github-tools/);

  // A user-scope server Claudius doesn't read (e.g. in ~/.claude.json).
  await expect(page.getByTestId("mcp-remove-notes")).toHaveCount(0);
  await expect(page.getByTestId("mcp-remove-hint-notes")).toHaveAttribute(
    "title",
    /claude mcp remove "notes" -s user/,
  );

  // Non-file scopes get a label instead of nothing.
  await expect(page.getByText("claude.ai", { exact: true })).toBeVisible();

  // A Remove that fails says why.
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("mcp-remove-docs").click();
  await expect(page.getByTestId("mcp-remove-error-docs")).toHaveText(`Couldn't remove: ${NOT_FOUND}`);
  expect(deletes).toBe(1);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-remove-hints.png"), fullPage: false });
});
