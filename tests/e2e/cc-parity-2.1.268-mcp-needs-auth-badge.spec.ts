/**
 * CC 2.1.268 — 'Changed the "N MCP servers need authentication" startup
 * notice to announce each server once instead of at every launch.'
 *
 * Claudius already has this notice (CC 2.1.193 parity: a `mcp_needs_auth_notice`
 * SSE event → transcript info pill pointing at `/mcp`, see
 * `tests/e2e/cc-parity-2.1.193-mcp-needs-auth-notice.spec.ts`). Its fire-once
 * gate was a private field on the `Session` class instance, which resets on
 * every new session — so it re-announced on every launch, exactly the
 * behavior upstream moved away from in 2.1.268.
 *
 * This release persists the "already announced" flag per MCP server name in
 * the per-cwd SQLite DB (`lib/server/mcp-needs-auth-db.ts`, migration 021)
 * and clears it once a server leaves `needs-auth`, so the transcript pill
 * only fires again on a genuinely new needs-auth episode. See
 * `tests/unit/mcp-needs-auth-db.test.ts` for that server-side dedup logic.
 *
 * That server-side dedup isn't independently e2e-testable without a real
 * two-session flow against a live MCP server (out of scope for this UI
 * spec — the unit test covers the dedup logic directly). What this spec
 * covers instead is the *standing* signal the suppression design relies
 * on: the `/mcp` page already renders a persistent, distinct "needs-auth"
 * badge per server (unaffected by the one-shot pill's dedup) — so
 * suppressing the repeat pill doesn't delete the only place a user can see
 * "this server still needs auth." We screenshot that badge in context
 * (SideNav + page chrome) as the CC 2.1.268 UI artifact for this release.
 *
 * Screenshot target: docs/cc-parity/2.1.268/mcp-needs-auth-badge.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.268");
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
            scope: "user",
            name: "github",
            config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          },
          {
            scope: "project",
            name: "linear",
            config: { type: "http", url: "https://mcp.linear.app/mcp" },
          },
        ],
        status: [
          { name: "github", status: "needs-auth" },
          { name: "linear", status: "connected", tools: [{ name: "search_issues" }] },
        ],
        statusError: null,
      }),
    });
  });
});

test.describe("CC 2.1.268 — MCP needs-auth badge is the standing per-server signal", () => {
  test("a needs-auth server shows a distinct amber badge alongside a connected server", async ({
    page,
  }) => {
    await page.goto("/mcp");

    const needsAuthBadge = page.getByTestId("mcp-status-badge-github");
    await expect(needsAuthBadge).toBeVisible({ timeout: 15_000 });
    await expect(needsAuthBadge).toHaveText("needs-auth");

    const connectedBadge = page.getByTestId("mcp-status-badge-linear");
    await expect(connectedBadge).toBeVisible();
    await expect(connectedBadge).toHaveText("connected");

    // The two badges must render with visibly different styling — the
    // needs-auth badge is the amber standing signal a user should notice
    // even once the one-shot transcript pill stops repeating.
    const needsAuthClass = await needsAuthBadge.getAttribute("class");
    const connectedClass = await connectedBadge.getAttribute("class");
    expect(needsAuthClass).not.toEqual(connectedClass);
    expect(needsAuthClass).toContain("amber");
    expect(connectedClass).toContain("emerald");

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "mcp-needs-auth-badge.png"),
      fullPage: false,
    });
  });
});
