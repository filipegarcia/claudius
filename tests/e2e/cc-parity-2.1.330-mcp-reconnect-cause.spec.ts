/**
 * CC 2.1.330 — "Improved Reconnect in `/mcp` and `/plugin`: a server's page
 * now stays open, with the cause in view, when the server still fails or
 * needs sign-in". This covers the `/mcp` half; Claudius's /plugins page has
 * no per-server Reconnect.
 *
 * On /mcp, Reconnect dropped the route's error (useMcp.reconnect returned a
 * bare boolean nobody read) and the row stayed collapsed, so a server that
 * still failed or still needed sign-in looked as if nothing had happened. The
 * row now opens itself with the cause: the reconnect call's error, or the
 * refreshed status's reason, or a sign-in note for needs-auth.
 *
 * /api/mcp, /api/sessions and the reconnect route are mocked.
 *
 * Screenshot target: docs/cc-parity/2.1.330/mcp-reconnect-cause.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000012330";

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
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: [
          { scope: "user", name: "github", config: { command: "npx", args: ["-y", "server-github"] } },
          { scope: "project", name: "linear", config: { type: "http", url: "https://mcp.linear.app/mcp" } },
        ],
        // Every fetch answers the same: the servers still don't connect.
        status: [
          { name: "github", status: "failed", error: "connection refused" },
          { name: "linear", status: "needs-auth" },
        ],
        statusError: null,
      }),
    });
  });
});

test("Reconnect that still fails or needs sign-in opens the row with the cause", async ({ page }) => {
  await page.route("**/api/mcp/*/reconnect*", async (route: Route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").slice(-2, -1)[0]);
    if (name === "github") {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "spawn npx ENOENT" }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/mcp");
  await expect(page.getByTestId("mcp-status-badge-github")).toBeVisible({ timeout: 15_000 });

  // Rows start collapsed.
  await expect(page.getByTestId("mcp-row-toggle-github")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("mcp-row-toggle-linear")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("mcp-reconnect-error-github")).toHaveCount(0);

  // The reconnect call fails: the row opens with its error and the status's.
  const github = page.getByTestId("mcp-row-toggle-github").locator("xpath=../..");
  await github.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByTestId("mcp-row-toggle-github")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("mcp-reconnect-error-github")).toHaveText("Reconnect failed: spawn npx ENOENT");
  await expect(page.getByTestId("mcp-status-error-github")).toHaveText("connection refused");

  // The call succeeds but the refreshed status still needs sign-in.
  const linear = page.getByTestId("mcp-row-toggle-linear").locator("xpath=../..");
  await linear.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByTestId("mcp-reconnect-still-failing-linear")).toHaveText(
    "Still needs sign-in — this server won't connect until you authenticate it.",
  );
  await expect(page.getByTestId("mcp-row-toggle-linear")).toHaveAttribute("aria-expanded", "true");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-reconnect-cause.png"), fullPage: false });

  // Collapsing the row dismisses the cause; it stays closed.
  await page.getByTestId("mcp-row-toggle-github").click();
  await expect(page.getByTestId("mcp-row-toggle-github")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("mcp-reconnect-error-github")).toHaveCount(0);
});

test("Reconnect all opens each row that still fails", async ({ page }) => {
  await page.route("**/api/mcp/*/reconnect*", async (route: Route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "timed out" }) }),
  );

  await page.goto("/mcp");
  await page.getByTestId("mcp-reconnect-all").click({ timeout: 15_000 });
  await expect(page.getByTestId("mcp-reconnect-error-github")).toHaveText("Reconnect failed: timed out");
  await expect(page.getByTestId("mcp-reconnect-error-linear")).toHaveText("Reconnect failed: timed out");
});
