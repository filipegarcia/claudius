/**
 * "Resume from summary" offer — Claudius's version of the Claude Code TUI's
 * stale-resume dialog. When the active session's last message is ≥70 min old
 * (prompt cache long expired) and its context is ≥100k tokens, the chat offers
 * to /compact before the next turn re-sends everything.
 *
 * Drives the SSE stream and the /context poll with `page.route` (same harness
 * as cc-parity-2.1.216-context-and-compact.spec.ts) — no real agent needed.
 * Message age comes from the `at` envelope on each replayed `sdk` event.
 *
 * Screenshot target: docs/resume-from-summary/offer.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/resume-from-summary");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "7e5a3e00-0000-4000-8000-000000000070";
const HOUR = 60 * 60_000;

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function conversation(at: number): SdkEvent[] {
  return [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    {
      type: "sdk",
      message: { type: "system", subtype: "init", uuid: "sys-init-rfs", model: "claude-sonnet-4-6" },
    },
    {
      type: "sdk",
      at: at - 60_000,
      message: {
        type: "user",
        uuid: "u-rfs-1",
        message: { role: "user", content: [{ type: "text", text: "Refactor the scheduler." }] },
      },
    },
    {
      type: "sdk",
      at,
      message: {
        type: "assistant",
        uuid: "a-rfs-1",
        message: { role: "assistant", content: [{ type: "text", text: "Done — the scheduler is refactored." }] },
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ];
}

async function mockChatBackend(
  page: Page,
  opts: { lastMessageAgoMs: number; totalTokens: number },
): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  const events = conversation(Date.now() - opts.lastMessageAgoMs);
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body?.text ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/context*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        totalTokens: opts.totalTokens,
        maxTokens: 1_000_000,
        percentage: (opts.totalTokens / 1_000_000) * 100,
      }),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
  return { inputs };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Resume from summary offer", () => {
  test("an idle, large session offers a summary; accepting runs /compact", async ({ page }) => {
    const { inputs } = await mockChatBackend(page, { lastMessageAgoMs: 3 * HOUR, totalTokens: 150_000 });
    await page.goto("/");

    const offer = page.getByTestId("resume-summary-offer");
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("resume-summary-title")).toHaveText(
      "This session is 3h old and 150k tokens.",
    );

    await page.waitForTimeout(150);
    await offer.screenshot({ path: resolve(SHOTS_DIR, "offer.png") });

    await page.getByTestId("resume-summary-compact").click();
    await expect.poll(() => inputs).toContain("/compact");
    await expect(offer).toHaveCount(0);
  });

  test("'Resume full session as-is' hides it without compacting", async ({ page }) => {
    const { inputs } = await mockChatBackend(page, { lastMessageAgoMs: 2 * HOUR, totalTokens: 120_000 });
    await page.goto("/");

    const offer = page.getByTestId("resume-summary-offer");
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("resume-summary-continue").click();
    await expect(offer).toHaveCount(0);
    // The next idle poll lands a fresh reading — the answered offer must not return.
    await page.waitForTimeout(500);
    await expect(offer).toHaveCount(0);
    expect(inputs).not.toContain("/compact");
  });

  test("'Don't ask me again' turns it off until re-enabled in Settings", async ({ page }) => {
    await mockChatBackend(page, { lastMessageAgoMs: 2 * HOUR, totalTokens: 120_000 });
    await page.goto("/");

    const offer = page.getByTestId("resume-summary-offer");
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("resume-summary-never").click();
    await expect(offer).toHaveCount(0);
    expect(
      await page.evaluate(() => window.localStorage.getItem("claudius.resumeFromSummaryEnabled")),
    ).toBe("false");

    await page.reload();
    await expect(page.getByText("Done — the scheduler is refactored.")).toBeVisible({ timeout: 15_000 });
    // Past the watcher's first poll (1.5s) — still nothing.
    await page.waitForTimeout(2_500);
    await expect(offer).toHaveCount(0);

    await page.goto("/settings");
    const toggle = page.getByTestId("resume-summary-enabled-toggle");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    expect(
      await page.evaluate(() => window.localStorage.getItem("claudius.resumeFromSummaryEnabled")),
    ).toBe("true");
  });

  test("a recent session stays quiet, however large", async ({ page }) => {
    await mockChatBackend(page, { lastMessageAgoMs: 10 * 60_000, totalTokens: 400_000 });
    await page.goto("/");
    await expect(page.getByText("Done — the scheduler is refactored.")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId("resume-summary-offer")).toHaveCount(0);
  });

  test("a small idle session stays quiet", async ({ page }) => {
    await mockChatBackend(page, { lastMessageAgoMs: 5 * HOUR, totalTokens: 40_000 });
    await page.goto("/");
    await expect(page.getByText("Done — the scheduler is refactored.")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId("resume-summary-offer")).toHaveCount(0);
  });
});
