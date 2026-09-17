/**
 * Claude Code 2.1.275 — "Added the signed-in account to Claude apps gateway
 * sign-in: when the gateway names it, you confirm it before the credential
 * is saved, and `/status` shows it."
 *
 * Claudius has no gateway-mediated sign-in driver to add a confirmation
 * step to (its OAuth flow is a direct, hardcoded Anthropic exchange — see
 * the run-notes Risks section), but the "/status shows it" half is a real,
 * pre-existing gap: `lib/shared/slash-commands.ts` already advertises
 * `/status` as showing "session/account/connectivity status", yet
 * `StatusOverlay` never rendered an account row at all. Claudius already
 * carries the account-switcher profile a session runs under on the SDK
 * `ready` event (`SessionReadyEvent.account`, consumed by `StatusLine`'s
 * account badge) — this just threads that same value into the overlay.
 *
 * Screenshot target: docs/cc-parity/2.1.275/status-account.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.275");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "cccccccc-1111-2222-3333-0000002752st";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

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
}

function preludeWithAccount(account: Record<string, unknown> | undefined): SdkEvent[] {
  return [
    { type: "ready", sessionId: FAKE_SESSION_ID, ...(account ? { account } : {}) },
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "init",
        uuid: "sys-init-0",
        model: "claude-sonnet-4-6",
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("/status shows the signed-in account (CC 2.1.275 parity)", () => {
  test("typing /status opens the overlay with an Account row naming the profile", async ({
    page,
  }) => {
    await mockChatBackend(
      page,
      preludeWithAccount({ id: "acct-1", label: "Personal Max" }),
    );
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/status");
    await page.getByTestId("prompt-send").click();

    const account = page.getByTestId("status-account");
    await expect(account).toBeVisible({ timeout: 5_000 });
    await expect(account).toContainText("Personal Max");

    // Screenshot in context: full overlay chrome (title, subtitle, every
    // other /status row) with the new Account row among them.
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "status-account.png"), fullPage: false });
  });

  test("names the drifted-to account when the session is pinned off the current default", async ({
    page,
  }) => {
    await mockChatBackend(
      page,
      preludeWithAccount({
        id: "acct-1",
        label: "Work",
        driftFromActive: { id: "acct-2", label: "Personal Max" },
      }),
    );
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/status");
    await page.getByTestId("prompt-send").click();

    const account = page.getByTestId("status-account");
    await expect(account).toBeVisible({ timeout: 5_000 });
    await expect(account).toContainText("Work");
    await expect(account).toContainText("Personal Max");
  });

  test("falls back to 'ambient environment' when no account profile is configured", async ({
    page,
  }) => {
    await mockChatBackend(page, preludeWithAccount(undefined));
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/status");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByText("Session status")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("status-account")).toHaveCount(0);
    await expect(page.getByText("ambient environment")).toBeVisible();
  });
});
