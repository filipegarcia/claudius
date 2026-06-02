import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Tests for the `AgentPicker` component in the StatusLine (SDK 0.3.161+).
 *
 * `applyFlagSettings({ agent })` now live-applies main-thread agent changes.
 * Claudius exposes this via `Session.setAgent()` → `POST /api/sessions/[id]/agent`
 * and surfaces an interactive picker wired into the StatusLine agent badge.
 *
 * The agent list (`GET /api/sessions/[id]/agents`) requires a live SDK
 * session; these tests exercise the badge and dropdown shell — which render
 * entirely in the browser from SSE state — using the mock `chromium` harness.
 *
 * Scenarios covered:
 * 1. Default session (no agent) — badge shows "Default", dropdown opens with reset entry.
 * 2. Named-agent session — badge shows the agent name, dropdown opens.
 * 3. `agent_changed` SSE event — badge updates to the new agent name without reload.
 */

const FAKE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * Stub the minimum backend for the chat page to boot and the SSE-driven
 * state machine to settle. `agentName` optionally populates the `agent`
 * field on the `ready` event to simulate a session started with a named agent.
 */
async function mockChatBackend(
  page: Page,
  extraEvents: SdkEvent[] = [],
  agentName?: string,
): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });

  const readyEvent: SdkEvent = { type: "ready", sessionId: FAKE_SESSION_ID };
  if (agentName) readyEvent.agent = agentName;

  const baseEvents: SdkEvent[] = [
    readyEvent,
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "init",
        uuid: "sys-1",
        model: "claude-sonnet-4-6",
      },
    },
    { type: "replay_done", hasMoreAbove: false },
    { type: "turn_status", status: "idle" },
  ];

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody([...baseEvents, ...extraEvents]),
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

  // Agent list for the picker dropdown — return an empty list so the picker
  // shows "No additional agents found" instead of a loading spinner forever.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/agents`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    });
  });

  // Stub the agent-switch POST so clicking the reset entry doesn't 500.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/agent`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, agent: null }),
    });
  });
}

test.describe("AgentPicker (SDK 0.3.161)", () => {
  test("default session: badge shows 'Default' and dropdown opens", async ({ page }) => {
    // No `agent` field on the ready event → mainAgent is null → picker shows "Default".
    await mockChatBackend(page);
    await page.goto("/");

    // The agent badge should be present and read "Default".
    const badge = page.getByTestId("status-line-agent");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("Default");

    // Click the badge to open the dropdown.
    await badge.click();

    const menu = page.getByTestId("agent-picker-menu");
    await expect(menu).toBeVisible();

    // The reset-to-default entry should always be present.
    await expect(page.getByTestId("agent-picker-default")).toBeVisible();
  });

  test("named-agent session: badge shows agent name", async ({ page }) => {
    // `agent: 'code-reviewer'` on the ready event → mainAgent = 'code-reviewer'.
    await mockChatBackend(page, [], "code-reviewer");
    await page.goto("/");

    const badge = page.getByTestId("status-line-agent");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("code-reviewer");
    // data-agent attribute mirrors the current name.
    await expect(badge).toHaveAttribute("data-agent", "code-reviewer");

    // Dropdown still opens and includes the reset entry.
    await badge.click();
    await expect(page.getByTestId("agent-picker-menu")).toBeVisible();
    await expect(page.getByTestId("agent-picker-default")).toBeVisible();
  });

  test("agent_changed SSE event: badge updates without reload", async ({ page }) => {
    // Start with code-reviewer, then receive an agent_changed event switching to
    // 'Explore' — the badge should update live without a reload.
    await mockChatBackend(page, [{ type: "agent_changed", agent: "Explore" }], "code-reviewer");
    await page.goto("/");

    const badge = page.getByTestId("status-line-agent");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    // After the agent_changed event the badge should reflect the new agent.
    await expect(badge).toHaveText("Explore");
  });

  test("close dropdown with Escape", async ({ page }) => {
    await mockChatBackend(page);
    await page.goto("/");

    const badge = page.getByTestId("status-line-agent");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();
    await expect(page.getByTestId("agent-picker-menu")).toBeVisible();

    // Escape should close the dropdown.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-picker-menu")).not.toBeVisible();
  });
});
