import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * SDK-update 0.3.186 — subagent agent_id in permission prompts.
 *
 * Prior to SDK 0.3.186, background subagents auto-denied all tool calls.
 * 0.3.186 changed that: they now forward permission prompts to the host via
 * `canUseTool`, and pass an `agent_id` so the host knows which subagent is
 * asking. Claudius surfaces this as a "Subagent · <id>" badge in the
 * permission modal header.
 *
 * This spec exercises the UI path end-to-end using a synthetic
 * `permission_request` SSE event (the same strategy as turn-status.spec.ts
 * and sdk-update-0.3.170-fable-model.spec.ts). No real SDK required.
 *
 * Screenshot target: docs/sdk-updates/0.3.187/subagent-permission-modal.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.187");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-agent0000187";
const FAKE_AGENT_ID = "agent-abc123";
const FAKE_REQUEST_ID = "req-00000000-perm-0000";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-187",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

/** A synthetic permission_request event with agentId populated. */
const SUBAGENT_PERMISSION_EVENT: SdkEvent = {
  type: "permission_request",
  requestId: FAKE_REQUEST_ID,
  toolName: "Bash",
  toolUseId: "toolu_subagent_bash_001",
  input: { command: "ls -la /tmp" },
  title: "Run a shell command",
  description: "Execute `ls -la /tmp` in the project directory.",
  displayName: "Run Bash",
  agentId: FAKE_AGENT_ID,
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

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/stream*`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: sseBody(events),
      });
    },
  );

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ asks: [], permissions: [] }),
      });
    },
  );

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/permission`,
    async (route: Route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fallback();
    },
  );
}

test.describe("SDK 0.3.186 — subagent agent_id in permission prompts", () => {
  test("permission modal shows Subagent badge when agentId is present", async ({
    page,
  }) => {
    await mockChatBackend(page, [...PRELUDE, SUBAGENT_PERMISSION_EVENT]);

    await page.goto("/");

    // Wait for the permission modal to appear.
    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // The agent badge must be visible and carry the correct ID.
    const badge = page.getByTestId("permission-agent-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(FAKE_AGENT_ID);
    await expect(badge).toContainText("Subagent");

    // The tool name is shown in the collapsible input header.
    await expect(modal).toContainText("Bash");

    // Capture the modal in context for the PR review.
    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200); // let layout settle
    await page.screenshot({
      path: resolve(SHOTS_DIR, "subagent-permission-modal.png"),
      fullPage: false,
    });

    // Resolve the prompt so the spec cleans up correctly.
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test("permission modal without agentId shows no Subagent badge", async ({
    page,
  }) => {
    // Baseline: a main-thread permission prompt should have no badge.
    const mainPermission: SdkEvent = {
      ...SUBAGENT_PERMISSION_EVENT,
      requestId: "req-00000001-perm-main",
      agentId: undefined,
    };
    // Remove the undefined key so the event JSON doesn't carry it.
    delete (mainPermission as Record<string, unknown>).agentId;

    await mockChatBackend(page, [...PRELUDE, mainPermission]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // No badge should be present for main-thread prompts.
    const badge = page.getByTestId("permission-agent-badge");
    await expect(badge).not.toBeVisible();

    // Resolve the prompt.
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });
});
