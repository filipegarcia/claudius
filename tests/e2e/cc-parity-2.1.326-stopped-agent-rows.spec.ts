/**
 * CC 2.1.326 parity — "Fixed stopped and failed agents looking like running
 * ones in the agent rows under the prompt, or showing "Done" when run in
 * parallel, and a stopped agent's last command still showing "Running…"".
 *
 * A subagent that is stopped mid-call never sends a tool_result for its last
 * tool_use, so the inner row in the TaskBlock trail used to pulse with a live
 * elapsed timer forever. This spec streams an Agent tool_use whose subagent
 * runs a Read (which finishes) and then a Bash (which never gets a result),
 * followed by a `task_notification` with `status: "stopped"`, and asserts the
 * Bash row reads "Not run · stopped" with no running timer.
 *
 * Screenshot target: docs/cc-parity/2.1.326/stopped-agent-rows.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000326sa01";
const AGENT_TOOL_USE_ID = "toolu_agent_326_1";
const INNER_READ_TOOL_USE_ID = "toolu_inner_read_326_1";
const INNER_BASH_TOOL_USE_ID = "toolu_inner_bash_326_1";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-326sa", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: NOW - 5_000,
    message: {
      type: "user",
      uuid: "user-sa-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Run the test suite in a subagent." }] },
    },
  },
  // Top-level turn spawns a subagent via the Agent tool.
  {
    type: "sdk",
    at: NOW - 4_000,
    message: {
      type: "assistant",
      uuid: "assistant-sa-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_sa_1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "Handing the test run to a subagent." },
          {
            type: "tool_use",
            id: AGENT_TOOL_USE_ID,
            name: "Agent",
            input: {
              subagent_type: "general-purpose",
              description: "Run the test suite",
              prompt: "Run the unit tests and report failures.",
            },
          },
        ],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 3_500,
    message: {
      type: "system",
      subtype: "task_started",
      uuid: "sys-task-started-sa",
      task_id: "task_sa_1",
      tool_use_id: AGENT_TOOL_USE_ID,
      description: "Run the test suite",
      subagent_type: "general-purpose",
    },
  },
  // The subagent reads the package manifest (this call finishes) …
  {
    type: "sdk",
    at: NOW - 3_000,
    message: {
      type: "assistant",
      uuid: "sub-assistant-sa-1",
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        id: "msg_sub_sa_1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: INNER_READ_TOOL_USE_ID, name: "Read", input: { file_path: "/tmp/package.json" } },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 2_800,
    message: {
      type: "user",
      uuid: "sub-user-sa-1",
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: INNER_READ_TOOL_USE_ID, content: '{ "name": "demo" }' }],
      },
    },
  },
  // … then starts the test run, which never gets a tool_result …
  {
    type: "sdk",
    at: NOW - 2_500,
    message: {
      type: "assistant",
      uuid: "sub-assistant-sa-2",
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        id: "msg_sub_sa_2",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: INNER_BASH_TOOL_USE_ID, name: "Bash", input: { command: "bun run test" } },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    },
  },
  // … because the agent is stopped.
  {
    type: "sdk",
    at: NOW - 1_000,
    message: {
      type: "system",
      subtype: "task_notification",
      uuid: "sys-task-notification-sa",
      task_id: "task_sa_1",
      tool_use_id: AGENT_TOOL_USE_ID,
      status: "stopped",
      summary: "Run the test suite",
    },
  },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
}

/**
 * The app-wide updater banner reflects the dev machine's real updater state
 * (not mocked here) and has nothing to do with this feature — dismiss it so
 * the screenshot shows the page chrome without unrelated noise.
 */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/ });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("a stopped agent's unfinished last command reads Not run, not running", async ({ page }) => {
  await page.goto("/");

  const taskBlock = page.getByTestId("task-block");
  await expect(taskBlock).toBeVisible({ timeout: 15_000 });
  await expect(taskBlock).toHaveAttribute("data-task-status", "stopped");

  // Expand the subagent trail.
  if ((await taskBlock.getAttribute("data-open")) !== "1") {
    await taskBlock.locator("button").first().click();
  }
  await expect(taskBlock).toHaveAttribute("data-open", "1");

  const innerRows = taskBlock.getByTestId("tool-call");
  await expect(innerRows).toHaveCount(2, { timeout: 15_000 });

  // The finished Read keeps its ordinary completed state.
  const readRow = taskBlock.locator('[data-testid="tool-call"][data-tool-name="Read"]');
  await expect(readRow).not.toHaveAttribute("data-not-run", "1");

  // The Bash call the agent never finished is settled, not running.
  const bashRow = taskBlock.locator('[data-testid="tool-call"][data-tool-name="Bash"]');
  await expect(bashRow).toHaveAttribute("data-not-run", "1");
  const notRun = bashRow.getByTestId("tool-call-not-run");
  await expect(notRun).toHaveText("Not run · stopped");
  await expect(notRun).toHaveAttribute("data-not-run-reason", "agent-stopped");
  await expect(notRun).toHaveAttribute("title", /agent was stopped/);
  await expect(bashRow.getByTestId("tool-call-elapsed")).toHaveCount(0);
  await expect(bashRow.locator(".animate-pulse")).toHaveCount(0);

  await dismissUpdaterBanner(page);
  await bashRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "stopped-agent-rows.png"), fullPage: false });
});
