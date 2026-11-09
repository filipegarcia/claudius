import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Claude Code 2.1.321 — "[VSCode] Fixed a plugin's permission request showing
 * a name with hidden characters: it now reads 'a plugin'".
 *
 * Claudius's permission card names the MCP server a tool comes from in its
 * source badge (`permission-mcp-source-badge`). That name is untrusted for
 * any non-`sdk` server — including one a plugin ships (sdk.d.ts: "escape it
 * before display") — but the badge printed it raw, while every other name on
 * the card already went through `visualizeInvisibleUnicode`. A right-to-left
 * override in a plugin server's name could make it read as a different
 * server. The badge now shows hidden characters as `‹U+XXXX›` tokens, and they
 * count toward the card's hidden-character banner.
 *
 * Synthetic SSE `permission_request` (same strategy as the 2.1.310 symlink
 * spec).
 *
 * Screenshot target: docs/cc-parity/2.1.321/permission-mcp-name.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-agent0002321";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-2321", model: "claude-sonnet-5-5" } },
  { type: "replay_done", hasMoreAbove: false },
];

function mcpPermission(serverName: string): SdkEvent {
  return {
    type: "permission_request",
    requestId: "req-2321-mcp",
    toolName: "mcp__tracker__create_issue",
    toolUseId: "toolu_mcp_2321",
    input: { title: "Flaky retry test in auth.spec.ts" },
    title: "Claude wants to use create_issue",
    displayName: "create_issue",
    mcpServer: { name: serverName, source: "plugin" },
  };
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/permission`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

test.describe("Claude Code 2.1.321 — hidden characters in a plugin MCP server's name", () => {
  test("the source badge shows the hidden character and the banner counts it", async ({ page }) => {
    // "tracker" + RIGHT-TO-LEFT OVERRIDE + "kcehc": renders as a different name.
    await mockChatBackend(page, [...PRELUDE, mcpPermission("tracker‮kcehc")]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const badge = page.getByTestId("permission-mcp-source-badge");
    await expect(badge).toHaveText("MCP · tracker‹U+202E›kcehc (plugin)");
    const banner = page.getByTestId("permission-hidden-chars");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Contains 1 hidden/bidi character");

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "permission-mcp-name.png"), fullPage: false });

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test("a clean server name shows as-is with no banner", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, mcpPermission("tracker")]);
    await page.goto("/");
    const badge = page.getByTestId("permission-mcp-source-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("MCP · tracker (plugin)");
    await expect(page.getByTestId("permission-hidden-chars")).toHaveCount(0);
  });
});
