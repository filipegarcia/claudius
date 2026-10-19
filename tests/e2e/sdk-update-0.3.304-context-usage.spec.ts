/**
 * SDK 0.3.304 — `getContextUsage()` gained stable row ids (`categories[].id`),
 * a per-server `mcpInstructions` breakdown, and skill `pluginName` / `pluginId`
 * / `path`. The Context overlay (`/context`) renders the MCP-instructions
 * breakdown, the plugin name next to each skill's source, and keys rows on the
 * stable id.
 *
 * Screenshot target: docs/sdk-updates/0.3.304/context-mcp-instructions.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.304");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const CONTEXT_RESPONSE = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 4000, color: "claude" },
    { id: "mcp_instructions", name: "MCP instructions", tokens: 1500, color: "permission" },
    { id: "messages", name: "Messages", tokens: 2000, color: "text" },
    { id: "free_space", name: "Free space", tokens: 192_500, color: "inactive", kind: "free" },
  ],
  totalTokens: 7500,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 4,
  gridRows: [],
  model: "claude-sonnet-4-6",
  memoryFiles: [],
  mcpTools: [],
  mcpInstructions: [
    { serverName: "github", tokens: 300 },
    { serverName: "linear", tokens: 1200 },
  ],
  agents: [
    { agentType: "code-reviewer", source: "plugin", pluginId: "viz-tools@acme-marketplace", path: "/home/u/agents/code-reviewer.md", tokens: 400 },
    { agentType: "docs-writer", source: "projectSettings", tokens: 150 },
  ],
  skills: {
    totalSkills: 2,
    includedSkills: 2,
    tokens: 700,
    skillFrontmatter: [
      {
        name: "dataviz",
        source: "plugin",
        tokens: 500,
        pluginName: "viz-tools",
        pluginId: "viz-tools@acme-marketplace",
        path: "/home/u/.claude/plugins/viz-tools/skills/dataviz/SKILL.md",
      },
      { name: "loop", source: "userSettings", tokens: 200 },
    ],
  },
};

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
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
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONTEXT_RESPONSE),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-1", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

async function openContext(page: Page): Promise<void> {
  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("/context");
  await page.getByTestId("prompt-send").click();
  await expect(page.getByText("Context window")).toBeVisible({ timeout: 15_000 });
}

test.describe("SDK 0.3.304 — richer getContextUsage() in the Context overlay", () => {
  test("shows per-server MCP instructions, skill plugin names and stable category ids", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await openContext(page);

    const rows = page.getByTestId("mcp-instructions-row");
    await expect(rows).toHaveCount(2);
    // Priciest first, regardless of fixture order.
    await expect(rows.nth(0)).toContainText("linear");
    await expect(rows.nth(0)).toContainText("1.2K");
    await expect(rows.nth(1)).toContainText("github");

    await expect(page.getByTestId("skill-plugin-name")).toHaveCount(1);
    await expect(page.getByTestId("skill-plugin-name")).toContainText("viz-tools");
    await expect(page.getByTestId("skill-cost-row").first()).toHaveAttribute(
      "title",
      /viz-tools\/skills\/dataviz\/SKILL\.md$/,
    );

    const agentRows = page.getByTestId("agent-cost-row");
    await expect(agentRows).toHaveCount(2);
    await expect(agentRows.nth(0)).toContainText("code-reviewer");
    await expect(agentRows.nth(0)).toHaveAttribute("title", "/home/u/agents/code-reviewer.md");
    await expect(page.getByTestId("agent-plugin-id")).toContainText("viz-tools@acme-marketplace");

    await expect(
      page.locator('[data-testid="context-category-row"][data-category-id="mcp_instructions"]'),
    ).toHaveCount(1);

    await page.getByTestId("mcp-instructions-list").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "context-mcp-instructions.png"),
      fullPage: false,
    });
  });

  test("older CLI (no new fields) renders without the MCP instructions section", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...CONTEXT_RESPONSE,
          mcpInstructions: undefined,
          agents: undefined,
          categories: CONTEXT_RESPONSE.categories.map(({ name, tokens, color }) => ({ name, tokens, color })),
        }),
      });
    });
    await openContext(page);

    await expect(page.getByTestId("mcp-instructions-row")).toHaveCount(0);
    await expect(page.getByTestId("agent-cost-row")).toHaveCount(0);
    await expect(page.getByTestId("context-category-row")).toHaveCount(4);
  });
});
