import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * Claude Code 2.1.247 — "Added a tip on Bash permission prompts pointing to
 * auto mode, with a one-keystroke 'Yes, and switch to auto mode' option."
 *
 * Claudius reimplements this as a tip row on the `Bash`-tool permission
 * modal (see `PermissionPrompt.tsx`'s `autoModeAvailable` prop): clicking
 * "Yes, and switch to auto mode" allows the pending request once AND flips
 * the session into Auto mode in one click, instead of two separate actions
 * (Allow, then open the mode selector and pick Auto).
 *
 * This spec exercises the UI path end-to-end using a synthetic
 * `permission_request` SSE event (same strategy as
 * sdk-update-0.3.187-subagent-permission.spec.ts). No real SDK required.
 *
 * Screenshot target: docs/cc-parity/2.1.247/permission-auto-mode-tip.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.247");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-agent0002147";
const FAKE_REQUEST_ID = "req-00000000-perm-2147";

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
      uuid: "sys-2147",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const BASH_PERMISSION_EVENT: SdkEvent = {
  type: "permission_request",
  requestId: FAKE_REQUEST_ID,
  toolName: "Bash",
  toolUseId: "toolu_bash_2147_001",
  input: { command: "npm test" },
  title: "Run a shell command",
  description: "Execute `npm test` in the project directory.",
  displayName: "Run Bash",
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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/permission`, async (route: Route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/mode`, async (route: Route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });
}

test.describe("Claude Code 2.1.247 — Bash permission auto-mode tip", () => {
  test("shows the tip and switches to Auto mode in one click", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, BASH_PERMISSION_EVENT]);
    await page.goto("/");

    const modal = page.locator("[data-permission-modal]");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("Bash");

    const tip = page.getByTestId("permission-auto-mode-tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Auto mode");

    // Capture the modal + tip in context before resolving it.
    await tip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "permission-auto-mode-tip.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: "Yes, and switch to auto mode" }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    // The mode selector trigger now reflects Auto mode.
    await expect(page.getByTestId("mode-selector-trigger")).toContainText("Auto", {
      timeout: 5_000,
    });
  });
});
