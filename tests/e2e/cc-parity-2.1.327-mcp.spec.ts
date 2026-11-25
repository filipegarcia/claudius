/**
 * CC 2.1.327 — two /mcp fixes.
 *
 * (a) "Changed claude mcp add --scope project to stop, instead of
 *     overwriting the file, when .mcp.json lists its servers at the top
 *     level with no mcpServers key". POST /api/mcp now answers 409 with the
 *     reason (unit-tested in tests/unit/cc-parity-2.1.327-mcp-json-shape.test.ts)
 *     and the Add form shows it instead of failing silently.
 *
 * (b) "Fixed /mcp saying no servers were configured after one was added
 *     during a session or declined; it now says what to do". A configured
 *     server missing from the live session's status used to render with no
 *     badge and no actions. It now gets a muted "Not loaded in this session"
 *     line, only once the session's status list has actually loaded. A
 *     project server the user rejected (`disabledMcpjsonServers`) is never
 *     started by the engine, so it says "Turned off in Settings" instead.
 *
 * /api/mcp and /api/sessions are mocked, so no real .mcp.json is touched.
 *
 * Screenshot targets: docs/cc-parity/2.1.327/mcp-json-shape.png,
 * docs/cc-parity/2.1.327/mcp-not-loaded.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000002327";
const SHAPE_ERROR =
  '.mcp.json lists its servers at the top level. Move them under "mcpServers" first, then add this server.';

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

  // `docs` is live in the session; `linear` (project) and `notes` (user)
  // are configured but the session never loaded them; `sentry` (project) is
  // in `disabledMcpjsonServers`, so the route marks it `rejected`. Without a
  // sessionId the route returns `status: null`, as the real one does.
  await page.route("**/api/mcp?*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const withSession = new URL(route.request().url()).searchParams.get("sessionId") === FAKE_SESSION_ID;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: [
          { scope: "user", name: "docs", config: { command: "npx", args: ["-y", "server-docs"] } },
          { scope: "project", name: "linear", config: { type: "http", url: "https://mcp.linear.app/mcp" } },
          { scope: "user", name: "notes", config: { command: "npx", args: ["-y", "server-notes"] } },
          {
            scope: "project",
            name: "sentry",
            config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
            rejected: true,
          },
        ],
        status: withSession ? [{ name: "docs", status: "connected", tools: [{ name: "search" }] }] : null,
        statusError: null,
      }),
    });
  });
});

test.describe("CC 2.1.327 — /mcp", () => {
  test("adding into a flat .mcp.json shows why it was refused", async ({ page }) => {
    // A flat .mcp.json has no `mcpServers` key, so the real route lists no
    // project servers — only the user-scope ones.
    await page.route("**/api/mcp?*", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const withSession = new URL(route.request().url()).searchParams.get("sessionId") === FAKE_SESSION_ID;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: [
            { scope: "user", name: "docs", config: { command: "npx", args: ["-y", "server-docs"] } },
            { scope: "user", name: "notes", config: { command: "npx", args: ["-y", "server-notes"] } },
          ],
          status: withSession ? [{ name: "docs", status: "connected", tools: [{ name: "search" }] }] : null,
          statusError: null,
        }),
      });
    });
    let posts = 0;
    await page.route("**/api/mcp", async (route: Route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: SHAPE_ERROR }) });
    });

    await page.goto("/mcp");
    await expect(page.getByTestId("mcp-status-badge-docs")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Add" }).click();
    await page.getByPlaceholder("my-server").fill("github");
    await page.getByPlaceholder("/usr/local/bin/my-mcp").fill("npx");
    await page.getByRole("button", { name: "Save" }).click();

    const error = page.getByTestId("mcp-add-error");
    await expect(error).toHaveText(SHAPE_ERROR);
    expect(posts).toBe(1);
    // The form stays open with what was typed, so nothing is lost.
    await expect(page.getByPlaceholder("my-server")).toHaveValue("github");

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-json-shape.png"), fullPage: false });
  });

  test("a configured server the session didn't load says what to do", async ({ page }) => {
    await page.goto("/mcp");
    await expect(page.getByTestId("mcp-status-badge-docs")).toBeVisible({ timeout: 15_000 });

    const notes = page.getByTestId("mcp-not-loaded-hint-notes");
    await expect(notes).toHaveText("Not loaded in this session. Start a new chat to connect it.");

    // A project server may also need approval, which lives in Settings.
    const linear = page.getByTestId("mcp-not-loaded-hint-linear");
    await expect(linear).toContainText("Not loaded in this session. Start a new chat to connect it.");
    await expect(linear).toContainText("approve it under MCP in Settings");
    await expect(linear.getByRole("link", { name: "Settings" })).toHaveAttribute("href", /\/settings#mcp$/);

    // A server rejected via disabledMcpjsonServers won't load in a new chat
    // either — it says where it was turned off instead.
    await expect(page.getByTestId("mcp-not-loaded-hint-sentry")).toHaveCount(0);
    const sentry = page.getByTestId("mcp-rejected-hint-sentry");
    await expect(sentry).toHaveText("Turned off in Settings (disabledMcpjsonServers).");
    await expect(sentry.getByRole("link", { name: "Settings" })).toHaveAttribute("href", /\/settings#mcp$/);

    // The loaded server gets its badge and no hint.
    await expect(page.getByTestId("mcp-not-loaded-hint-docs")).toHaveCount(0);

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "mcp-not-loaded.png"), fullPage: false });
  });

  test("no hint while there is no session", async ({ page }) => {
    await page.route("**/api/sessions", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/mcp");
    await expect(page.getByText("Start a chat session to see live connection status")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("notes", { exact: true })).toBeVisible();
    await expect(page.locator('[data-testid^="mcp-not-loaded-hint-"]')).toHaveCount(0);
  });
});
